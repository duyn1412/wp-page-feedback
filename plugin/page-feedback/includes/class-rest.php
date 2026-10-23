<?php
/**
 * REST for the widget and for MCP / Application Passwords.
 *
 * @package PageFeedback
 */

if (!defined('ABSPATH')) {
  exit;
}

class PFB_REST {
  public static function init() {
    add_action('rest_api_init', [self::class, 'register']);
  }

  public static function is_guest_allowed() {
    return (bool) get_option('pfb_allow_guest', false);
  }

  public static function can_read(WP_REST_Request $request = null) {
    if (self::is_guest_allowed()) {
      return true;
    }
    return current_user_can('edit_posts');
  }

  public static function can_write(WP_REST_Request $request = null) {
    if (self::is_guest_allowed()) {
      return true;
    }
    return current_user_can('edit_posts');
  }

  public static function register() {
    register_rest_route('pfb/v1', '/pages', [
      [
        'methods' => 'GET',
        'permission_callback' => [self::class, 'can_read'],
        'callback' => static function () {
          return rest_ensure_response([
            'pages' => PFB_Notes::list_pages(),
            'site' => get_bloginfo('name'),
            'home' => home_url('/'),
          ]);
        },
      ],
    ]);

    register_rest_route('pfb/v1', '/notes', [
      [
        'methods' => 'GET',
        'permission_callback' => [self::class, 'can_read'],
        'callback' => static function (WP_REST_Request $request) {
          $page = (string) $request->get_param('page');
          if ($page !== '') {
            return new WP_REST_Response(PFB_Notes::load_page($page), 200);
          }
          return rest_ensure_response([
            'notes' => PFB_Notes::query_notes([
              'status' => (string) $request->get_param('status'),
              'limit' => (int) $request->get_param('limit'),
            ]),
          ]);
        },
      ],
    ]);

    register_rest_route('pfb/v1', '/notes/(?P<id>[a-zA-Z0-9\-_]+)', [
      [
        'methods' => 'GET',
        'permission_callback' => [self::class, 'can_read'],
        'callback' => static function (WP_REST_Request $request) {
          $id = (string) $request['id'];
          $note = ctype_digit($id) ? PFB_Notes::get_by_id((int) $id) : PFB_Notes::get_by_entry_id($id);
          if (!$note) {
            return new WP_Error('pfb_missing', 'Note not found.', ['status' => 404]);
          }
          return rest_ensure_response($note);
        },
      ],
      [
        'methods' => 'POST',
        'permission_callback' => [self::class, 'can_write'],
        'callback' => static function (WP_REST_Request $request) {
          $id = (string) $request['id'];
          $result = PFB_Notes::update_agent_fields($id, [
            'status' => $request->get_param('status'),
            'resolution' => $request->get_param('resolution'),
            'question' => $request->get_param('question'),
          ]);
          if (is_wp_error($result)) {
            return $result;
          }
          return rest_ensure_response($result);
        },
      ],
    ]);

    register_rest_route('pfb/v1', '/sync', [
      [
        'methods' => 'POST',
        'permission_callback' => [self::class, 'can_write'],
        'callback' => static function (WP_REST_Request $request) {
          $data = $request->get_json_params();
          if (!is_array($data)) {
            $data = $request->get_body_params();
          }
          if (!is_array($data) || empty($data['page']) || !isset($data['entries']) || !is_array($data['entries'])) {
            return new WP_Error('pfb_invalid', 'Invalid payload', ['status' => 400]);
          }
          $result = PFB_Notes::merge_and_save(
            (string) $data['page'],
            $data['entries'],
            isset($data['deletedIds']) ? (array) $data['deletedIds'] : []
          );
          if (is_wp_error($result)) {
            $result->add_data(['status' => 500]);
            return $result;
          }
          return rest_ensure_response($result);
        },
      ],
    ]);
  }
}
