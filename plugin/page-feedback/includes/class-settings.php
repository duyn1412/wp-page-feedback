<?php
/**
 * Settings — widget stays off until an admin enables it.
 *
 * @package PageFeedback
 */

if (!defined('ABSPATH')) {
  exit;
}

class PFB_Settings {
  public static function init() {
    add_action('admin_menu', [self::class, 'menu']);
    add_action('admin_init', [self::class, 'register']);
  }

  public static function menu() {
    add_submenu_page(
      'edit.php?post_type=pfb_note',
      'Page Feedback settings',
      'Settings',
      'manage_options',
      'pfb-settings',
      [self::class, 'render']
    );
  }

  public static function register() {
    register_setting('pfb', 'pfb_enabled', [
      'type' => 'boolean',
      'default' => false,
      'sanitize_callback' => static function ($v) {
        return (bool) $v;
      },
    ]);
    register_setting('pfb', 'pfb_allow_query_override', [
      'type' => 'boolean',
      'default' => true,
      'sanitize_callback' => static function ($v) {
        return (bool) $v;
      },
    ]);
  }

  public static function render() {
    if (!current_user_can('manage_options')) {
      return;
    }
    $rest = rest_url('pfb/v1/');
    ?>
    <div class="wrap">
      <h1>Page Feedback</h1>
      <p>Click-to-comment widget for clients. The widget is <strong>off by default</strong>.</p>
      <form method="post" action="options.php">
        <?php settings_fields('pfb'); ?>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row">Enable widget</th>
            <td>
              <label>
                <input type="hidden" name="pfb_enabled" value="0" />
                <input type="checkbox" name="pfb_enabled" value="1" <?php checked(get_option('pfb_enabled', false)); ?> />
                Show the feedback dock on the front end for logged-in editors
              </label>
            </td>
          </tr>
          <tr>
            <th scope="row">URL override</th>
            <td>
              <label>
                <input type="hidden" name="pfb_allow_query_override" value="0" />
                <input type="checkbox" name="pfb_allow_query_override" value="1" <?php checked(get_option('pfb_allow_query_override', true)); ?> />
                Allow <code>?pfb=1</code> on a page URL (and <code>?pfb=0</code> to hide)
              </label>
            </td>
          </tr>
        </table>
        <?php submit_button(); ?>
      </form>

      <h2>MCP / Application Password</h2>
      <p>Create a WordPress Application Password for an editor account. Point the local MCP at this site:</p>
      <pre style="background:#fff;padding:12px;border:1px solid #dcdcde;max-width:720px;overflow:auto;"><?php echo esc_html('{
  "id": "this-site",
  "name": "' . get_bloginfo('name') . '",
  "url": "' . home_url('/') . '",
  "user": "YOUR_WP_USERNAME",
  "app_password": "xxxx xxxx xxxx xxxx xxxx xxxx"
}'); ?></pre>
      <p>REST base: <code><?php echo esc_html($rest); ?></code></p>
      <ul>
        <li><code>GET pages</code></li>
        <li><code>GET notes?status=open</code></li>
        <li><code>GET notes?page=home</code> (raw array for the widget)</li>
        <li><code>POST notes/{id}</code> — <code>status</code>, <code>resolution</code>, <code>question</code></li>
        <li><code>POST sync</code> — widget save</li>
      </ul>
    </div>
    <?php
  }
}
