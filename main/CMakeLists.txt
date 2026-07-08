idf_component_register(
    SRCS
        "app_main.c"
        "wifi_mgr.c"
        "ha_client.c"
        "panel_ui.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES nvs_flash esp_wifi esp_netif
)

# --- Embed secrets from the gitignored secrets/ directory -------------------
set(SECRETS_DIR ${CMAKE_CURRENT_LIST_DIR}/../secrets)

function(read_secret file out_var)
    set(path ${SECRETS_DIR}/${file})
    if(EXISTS ${path})
        file(READ ${path} val)
        string(STRIP "${val}" val)
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${path})
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
