/* HTTP handlers for the on-device telemetry dashboard.
 *
 * Registers three routes on an existing esp_http_server:
 *   GET /              -> the embedded charting dashboard (dashboard.html)
 *   GET /api/status    -> firmware/uptime JSON
 *   GET /api/metrics   -> the telemetry ring buffer as columnar JSON (chunked)
 */
#pragma once

#include "esp_http_server.h"

void web_ui_register(httpd_handle_t server);
