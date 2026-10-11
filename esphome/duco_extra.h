// More of the DucoBox Energy Comfort than the duco component reads, found by
// scanning its box parameters (fn 0x24 {00, group, index} -> 0x26 {01, group,
// index, value as 4 bytes, little endian}) on 2026-10-11 and checking which
// follow the ventilation level:
//   40/09, 44/09  supply / exhaust fan speed (rpm)
//   43/09, 47/09  supply / exhaust fan: a pressure or flow figure (unit unknown)
//   4D/09, 4E/09  supply / exhaust fan level (%)
//   13/0A         supply temperature target ("comfort temperature"), °C x 10
//   31/0A         filter lifetime (days: 90, 180, 270 or 360)
// Writes use the same function with {01, group, index, value LE}.
//
// The box's own settings (the display's SETTINGS > CONFIG > BOX) are read with
// fn 0x18 {00, node 01, param} -> 0x1A {valid, value, step, min, max} (each 2
// bytes, little endian; valid 00 = no such param) and written with
// {01, 01, param, 00, value}:
//   0 auto minimum %   1 auto maximum %   2 maximum flow (m3/h, 0 = not set)
//   6, 7, 8 stand I, II, III %   9 boost time (min)
// Its error log: fn 0x30 {01, 00, 00, 04} -> 0x33 (none) or 0x32 {count, then
// per error 5 bytes: node, then the code XX.YY.ZZ}. E43.23.01 = the air-side
// commissioning (inregeling) was never done or failed.
// Its software version: fn 0x10 {01, node 01, 00, 00, 04} -> 0x12 (a node
// memory read, as the duco component reads the serial; never send 0x10 {00, x},
// that switches the network to installer mode).
//
// Tables matched to the Connectivity Board's /config keys by default values and
// order (2026-10-11): 0x00 Ventilation.Ctrl (01 temperature-dependent control,
// 02/03 its thresholds °C x 10); 0x03 NightBoost (01 enable, 02 start
// temperature °C, 03/04 months, 05/06 minutes of the day, 07 max level %);
// 0x0A HeatRecovery (10 bypass mode 0 auto / 1 closed / 2 open, 11 adaptive).
#pragma once
#include <array>
#include <cstdio>
#include <string>
#include <functional>
#include "esphome/components/duco/duco.h"
#include "esphome/core/log.h"

class DucoExtra : public esphome::duco::DucoDevice {
 public:
  struct Param {
    uint8_t group, index;
    std::function<void(int32_t)> publish;
  };
  std::vector<Param> params;
  void add(uint8_t group, uint8_t index, std::function<void(int32_t)> publish) { params.push_back({group, index, publish}); }
  struct Setting {
    uint8_t param;
    std::function<void(int, int, int)> publish;  // value, min, max
  };
  std::vector<Setting> settings;
  void add_setting(uint8_t param, std::function<void(int, int, int)> publish) { settings.push_back({param, publish}); }
  std::function<void(const std::string &)> on_errors;
  std::function<void(const std::string &)> on_version;
  // one question per call: the parameters in turn, then a setting, and the error log now and then
  void poll() {
    esphome::duco::DucoMessage m;
    const size_t turns = params.size() + 2;
    pos_ = (pos_ + 1) % turns;
    if (pos_ < params.size()) {
      m.function = 0x24;
      m.data = {0x00, params[pos_].group, params[pos_].index};
    } else if (pos_ == params.size() && !settings.empty()) {
      setting_pos_ = (setting_pos_ + 1) % settings.size();
      asked_setting_ = settings[setting_pos_].param;
      m.function = 0x18;
      m.data = {0x00, 0x01, asked_setting_};
    } else if (pos_ == params.size() + 1 && on_version && !have_version_) {
      m.function = 0x10;
      m.data = {0x01, 0x01, 0x00, 0x00, 0x04};
    } else if (pos_ == params.size() + 1 && on_errors && ++error_turn_ % 6 == 0) {
      m.function = 0x30;
      m.data = {0x01, 0x00, 0x00, 0x04};
    } else {
      return;
    }
    this->parent_->send(m, this);
  }
  void write_setting(uint8_t param, int value) {
    if (value < 0 || value > 255) return;  // the write carries one value byte
    esphome::duco::DucoMessage m;
    m.function = 0x18;
    m.data = {0x01, 0x01, param, 0x00, (uint8_t) value};
    asked_setting_ = param;
    ESP_LOGI("duco_extra", "setting %u = %d", param, value);
    this->parent_->send(m, this);
  }
  void write(uint8_t group, uint8_t index, int32_t value) {
    esphome::duco::DucoMessage m;
    m.function = 0x24;
    last_write_group_ = group;
    last_write_index_ = index;
    m.data = {0x01, group, index, (uint8_t) (value & 0xff), (uint8_t) ((value >> 8) & 0xff),
              (uint8_t) ((value >> 16) & 0xff), (uint8_t) ((value >> 24) & 0xff)};
    ESP_LOGI("duco_extra", "write %02X/%02X = %d", group, index, (int) value);
    // the box confirms a write with a differently laid out answer: not a reading
    pending_writes_++;
    this->parent_->send(m, this);
  }
  void receive_response(const esphome::duco::DucoMessage &m) override {
    if (m.function == 0x1A) {
      this->parent_->stop_waiting(m.id);
      if (m.data.size() < 9 || m.data[0] != 0x01) return;
      auto word = [&](int i) { return (int) (m.data[i] | (m.data[i + 1] << 8)); };
      for (auto &st : settings)
        if (st.param == asked_setting_) st.publish(word(1), word(5), word(7));
      return;
    }
    if (m.function == 0x12) {
      this->parent_->stop_waiting(m.id);
      if (m.data.size() < 7 || !on_version) return;
      char v[32];  // product type, then the version (field order as w1ll14m/esphome_duco)
      snprintf(v, sizeof v, "%u v%u.%u.%u", (unsigned) (m.data[2] | (m.data[3] << 8)), m.data[4], m.data[6], m.data[5]);
      ESP_LOGI("duco_extra", "version %s", v);
      have_version_ = true;
      on_version(v);
      return;
    }
    if (m.function == 0x33 || m.function == 0x32) {
      this->parent_->stop_waiting(m.id);
      std::string errors;
      const size_t count = m.function == 0x32 && !m.data.empty() ? m.data[0] : 0;
      for (size_t e = 0; e < count && 1 + e * 5 + 3 < m.data.size(); e++) {
        char code[16];
        snprintf(code, sizeof code, "%s%02u.%02u.%02u", errors.empty() ? "" : " ", m.data[2 + e * 5],
                 m.data[3 + e * 5], m.data[4 + e * 5]);
        errors += code;
      }
      if (on_errors) on_errors(errors);
      return;
    }
    if (m.function == 0x26 && pending_writes_ > 0 && m.data.size() >= 3 && m.data[0] == 0x01 &&
        m.data[1] == last_write_group_ && m.data[2] == last_write_index_) {
      pending_writes_--;
      return;
    }
    if (m.function != 0x26 || m.data.size() < 7 || m.data[0] != 0x01) return;
    const int32_t v = (int32_t) (m.data[3] | (m.data[4] << 8) | (m.data[5] << 16) | (m.data[6] << 24));
    for (auto &p : params)
      if (p.group == m.data[1] && p.index == m.data[2]) p.publish(v);
  }
 private:
  size_t pos_ = 0, setting_pos_ = 0;
  uint32_t error_turn_ = 5;  // ask for the error log on the first round
  uint8_t asked_setting_ = 0xff;
  bool have_version_ = false;
  int pending_writes_ = 0;
  uint8_t last_write_group_ = 0, last_write_index_ = 0;
};

// The one reader, made at boot (globals are declared before this header is read).
inline DucoExtra *&duco_extra() {
  static DucoExtra *instance = nullptr;
  return instance;
}
