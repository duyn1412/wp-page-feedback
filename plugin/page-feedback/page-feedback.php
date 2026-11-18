<?php
/**
 * Plugin Name: Page Feedback
 * Description: Client click-to-comment widget, REST API, and MCP-ready notes for any WordPress site. Off by default.
 * Version: 0.1.10
 * Requires at least: 6.4
 * Requires PHP: 7.4
 * Author: Duy
 * License: GPL-2.0-or-later
 * Text Domain: page-feedback
 *
 * @package PageFeedback
 */

if (!defined('ABSPATH')) {
  exit;
}

define('PFB_VERSION', '0.1.10');
define('PFB_FILE', __FILE__);
define('PFB_DIR', plugin_dir_path(__FILE__));
define('PFB_URL', plugin_dir_url(__FILE__));

require_once PFB_DIR . 'includes/class-plugin.php';
require_once PFB_DIR . 'includes/class-notes.php';
require_once PFB_DIR . 'includes/class-cpt.php';
require_once PFB_DIR . 'includes/class-rest.php';
require_once PFB_DIR . 'includes/class-settings.php';

add_action('plugins_loaded', static function () {
  PFB_Plugin::instance()->init();
});
