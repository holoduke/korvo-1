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
#pragma once
#include <array>
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
  // one question per call; reads every parameter in turn
  void poll() {
    if (params.empty()) return;
    pos_ = (pos_ + 1) % params.size();
    esphome::duco::DucoMessage m;
    m.function = 0x24;
    m.data = {0x00, params[pos_].group, params[pos_].index};
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
  size_t pos_ = 0;
  int pending_writes_ = 0;
  uint8_t last_write_group_ = 0, last_write_index_ = 0;
};

// The one reader, made at boot (globals are declared before this header is read).
inline DucoExtra *&duco_extra() {
  static DucoExtra *instance = nullptr;
  return instance;
}
