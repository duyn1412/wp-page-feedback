<?php
/**
 * Bootstrap.
 *
 * @package PageFeedback
 */

if (!defined('ABSPATH')) {
  exit;
}

final class PFB_Plugin {
  /** @var self|null */
  private static $instance = null;

  public static function instance() {
    if (self::$instance === null) {
      self::$instance = new self();
    }
    return self::$instance;
  }

  public function init() {
    PFB_CPT::init();
    PFB_REST::init();
    PFB_Settings::init();
    add_action('wp_enqueue_scripts', [$this, 'enqueue_widget'], 40);
  }

  /**
   * Widget is off unless an admin turns it on, or ?pfb=1 is allowed.
   */
  public static function widget_enabled() {
    if (isset($_GET['pfb'])) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
      $flag = (string) wp_unslash($_GET['pfb']); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
      if ($flag === '0') {
        return false;
      }
      if ($flag !== '' && (bool) get_option('pfb_allow_query_override', true)) {
        return true;
      }
    }
    if (defined('PFB_ENABLED')) {
      return (bool) PFB_ENABLED;
    }
    return (bool) get_option('pfb_enabled', false);
  }

  public static function current_slug() {
    if (is_front_page()) {
      return 'home';
    }
    if (is_singular()) {
      $post = get_queried_object();
      if ($post instanceof WP_Post && $post->post_name) {
        return PFB_Notes::sanitize_slug($post->post_name);
      }
    }
    if (function_exists('is_shop') && is_shop()) {
      return 'store';
    }
    $path = (string) wp_parse_url(isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '', PHP_URL_PATH);
    $path = trim($path, '/');
    $path = preg_replace('#/(page)/\d+/?$#', '', $path);
    $path = str_replace('/', '-', $path);
    return PFB_Notes::sanitize_slug($path);
  }

  public function enqueue_widget() {
    if (is_admin() || !self::widget_enabled()) {
      return;
    }

    // Visible to administrators, or guests when guest access is enabled / ?pfb=1
    $allow_guest = (bool) get_option('pfb_allow_guest', true) || (isset($_GET['pfb']) && $_GET['pfb'] === '1');
    if (!$allow_guest && (!is_user_logged_in() || !current_user_can('manage_options'))) {
      return;
    }

    $logged_in = is_user_logged_in();
    $can_add = true;
    $redirect = home_url(add_query_arg([]));
    if (!empty($_SERVER['REQUEST_URI'])) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
      $redirect = home_url(wp_unslash($_SERVER['REQUEST_URI'])); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
    }

    wp_enqueue_script(
      'pfb-html2canvas',
      PFB_URL . 'assets/js/html2canvas.min.js',
      [],
      '1.4.1',
      true
    );

    $widget_file = PFB_DIR . 'assets/js/widget.js';
    $widget_ver = file_exists($widget_file) ? PFB_VERSION . '.' . filemtime($widget_file) : PFB_VERSION;
    wp_enqueue_script(
      'pfb-widget',
      PFB_URL . 'assets/js/widget.js',
      ['pfb-html2canvas'],
      $widget_ver,
      true
    );

    $client_ip = PFB_Notes::get_client_ip();
    wp_localize_script('pfb-widget', 'PFB', [
      'allowNew' => $can_add ? '1' : '0',
      'requireLogin' => '1',
      'loggedIn' => $logged_in ? '1' : '0',
      'isAdmin' => '1',
      'clientIp' => $client_ip,
      'loginUrl' => wp_login_url($redirect),
      'nonce' => wp_create_nonce('wp_rest'),
      'pageSlug' => self::current_slug(),
      'syncUrl' => esc_url_raw(rest_url('pfb/v1/sync')),
      'fileUrl' => esc_url_raw(add_query_arg('page', self::current_slug(), rest_url('pfb/v1/notes'))),
      'mediaBase' => esc_url_raw(trailingslashit(home_url('/'))),
      'pluginUrl' => esc_url_raw(PFB_URL),
    ]);
  }
}
