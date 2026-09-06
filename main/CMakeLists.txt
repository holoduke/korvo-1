idf_component_register(
    SRCS
        "app_main.c"
        "wifi_mgr.c"
        "ha_client.c"
        "panel_ui.c"
        "ota.c"
        "metrics.c"
        "web_ui.c"
        "lv_mem_psram.c"
        "climate_hist.c"
        "lv_pipeline_guard.c"
        "sys_reset.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES nvs_flash esp_wifi esp_netif esp_http_server app_update espcoredump
                  esp32_s31_korvo esp_hal_wdt
                  esp_driver_tsens esp_timer
    EMBED_TXTFILES "dashboard.html"
    EMBED_FILES "assets/splash_800x480.rgb565"
)

# --- Embed secrets from the gitignored secrets/ directory -------------------
set(SECRETS_DIR ${CMAKE_CURRENT_LIST_DIR}/../secrets)

function(read_secret file out_var)
    set(path ${SECRETS_DIR}/${file})
    # Watch the path unconditionally so that *creating* the file later still
    # triggers a reconfigure (CMake supports depending on not-yet-existing files).
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${path})
    if(EXISTS ${path})
        file(READ ${path} val)
        string(STRIP "${val}" val)
    else()
        message(WARNING "Secret file missing: ${path} - using placeholder")
        set(val "MISSING")
    endif()
    set(${out_var} "${val}" PARENT_SCOPE)
endfunction()

read_secret(wifi_ssid.txt SECRET_WIFI_SSID)
read_secret(wifi_pass.txt SECRET_WIFI_PASS)
read_secret(ha_token.txt SECRET_HA_TOKEN)

configure_file(${CMAKE_CURRENT_LIST_DIR}/secrets.h.in ${CMAKE_CURRENT_BINARY_DIR}/gen/secrets.h @ONLY)
target_include_directories(${COMPONENT_LIB} PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/gen)

# --- Keep LVGL out of internal RAM (see lv_mem_psram.c) ----------------------
target_link_libraries(${COMPONENT_LIB} INTERFACE
    "-Wl,--wrap=lv_malloc_core" "-Wl,--wrap=lv_realloc_core" "-Wl,--wrap=lv_free_core"
    # force the wrappers' object out of libmain.a (nothing references it before LVGL is linked)
    "-u __wrap_lv_malloc_core" "-u __wrap_lv_realloc_core" "-u __wrap_lv_free_core"
    # Bounded, self-healing frame-buffer wait (see lv_pipeline_guard.c)
    "-Wl,--wrap=display_bridge_pipeline_wait_free_buf" "-u __wrap_display_bridge_pipeline_wait_free_buf"
    "-Wl,--wrap=display_bridge_vsync_on_isr" "-u __wrap_display_bridge_vsync_on_isr"
    "-Wl,--wrap=gdma_request_link_switch_event" "-u __wrap_gdma_request_link_switch_event"
    "-Wl,--wrap=esp_lcd_rgb_panel_register_event_callbacks" "-u __wrap_esp_lcd_rgb_panel_register_event_callbacks"
    # Every esp_restart() becomes a full-chip reset (see sys_reset.c)
    "-Wl,--wrap=esp_restart" "-u __wrap_esp_restart")
# The guard reads the adapter's private pipeline structs for its diagnostics.
idf_component_get_property(_lv_adapter_dir espressif__esp_lvgl_adapter COMPONENT_DIR)
target_include_directories(${COMPONENT_LIB} PRIVATE
    ${_lv_adapter_dir}/src/adapter ${_lv_adapter_dir}/src/display/bridge/common)
