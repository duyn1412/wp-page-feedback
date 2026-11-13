<?php
/**
 * Private CPT for notes (admin list, not public).
 *
 * @package PageFeedback
 */

if (!defined('ABSPATH')) {
  exit;
}

class PFB_CPT {
  public static function init() {
    add_action('init', [self::class, 'register']);
    add_filter('manage_pfb_note_posts_columns', [self::class, 'columns']);
    add_action('manage_pfb_note_posts_custom_column', [self::class, 'column_content'], 10, 2);
    add_action('restrict_manage_posts', [self::class, 'filters']);
    add_action('pre_get_posts', [self::class, 'apply_filters']);
    add_action('before_delete_post', [self::class, 'on_delete_post']);
  }

  public static function register() {
    register_post_type('pfb_note', [
      'labels' => [
        'name' => 'Page Feedback',
        'singular_name' => 'Feedback note',
        'menu_name' => 'Page Feedback',
        'all_items' => 'All notes',
      ],
      'public' => false,
      'show_ui' => true,
      'show_in_menu' => true,
      'show_in_rest' => false,
      'menu_icon' => 'dashicons-feedback',
      'supports' => ['title', 'editor', 'excerpt'],
      'capability_type' => 'post',
      'map_meta_cap' => true,
    ]);
  }

  public static function columns($cols) {
    return [
      'cb' => $cols['cb'] ?? '',
      'pfb_thumb' => 'Preview',
      'title' => 'Note',
      'pfb_status' => 'Status',
      'pfb_viewport' => 'Screen',
      'pfb_ip' => 'IP Address',
      'pfb_page' => 'Page',
      'pfb_selector' => 'Selector',
      'date' => 'Date',
    ];
  }

  public static function column_content($col, $post_id) {
    if ($col === 'pfb_thumb') {
      $payload = get_post_meta($post_id, '_pfb_payload', true);
      $img = '';
      if (!empty($payload['image'])) {
        $img = $payload['image'];
      } elseif (!empty($payload['images']) && is_array($payload['images']) && !empty($payload['images'][0])) {
        $img = $payload['images'][0];
      }
      if ($img) {
        printf('<a href="%s" target="_blank"><img src="%s" style="width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid #ccd0d4;display:block;" alt="" /></a>', esc_url($img), esc_url($img));
      } else {
        echo '<span style="color:#a7aaad;">—</span>';
      }
    }
    if ($col === 'pfb_status') {
      $status = get_post_meta($post_id, '_pfb_status', true) ?: 'open';
      $bg = '#d63638'; $color = '#fff';
      if ($status === 'done') { $bg = '#00a32a'; }
      elseif ($status === 'needs_info') { $bg = '#dba617'; }
      printf('<span style="background:%s;color:%s;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase;display:inline-block;">%s</span>', esc_attr($bg), esc_attr($color), esc_html($status));
    }
    if ($col === 'pfb_viewport') {
      $vp = get_post_meta($post_id, '_pfb_viewport', true);
      if ($vp) {
        printf('<span style="font-family:monospace;font-size:11px;background:#f0f0f1;padding:2px 6px;border-radius:3px;">%s</span>', esc_html($vp));
      } else {
        echo '<span style="color:#a7aaad;">—</span>';
      }
    }
    if ($col === 'pfb_ip') {
      $ip = get_post_meta($post_id, '_pfb_ip', true);
      if ($ip) {
        $filter_url = add_query_arg(['post_type' => 'pfb_note', 'pfb_ip' => $ip], admin_url('edit.php'));
        printf('<a href="%s" style="font-family:monospace;font-size:11px;background:#eef2f5;padding:2px 6px;border-radius:3px;text-decoration:none;" title="Filter by this IP">%s</a>', esc_url($filter_url), esc_html($ip));
      } else {
        echo '<span style="color:#a7aaad;">—</span>';
      }
    }
    if ($col === 'pfb_page') {
      echo esc_html(get_post_meta($post_id, '_pfb_page', true));
    }
    if ($col === 'pfb_selector') {
      echo '<code>' . esc_html(wp_html_excerpt((string) get_post_meta($post_id, '_pfb_selector', true), 60)) . '</code>';
    }
  }

  public static function filters($post_type) {
    if ($post_type !== 'pfb_note') {
      return;
    }
    $status = isset($_GET['pfb_status']) ? sanitize_key(wp_unslash($_GET['pfb_status'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
    echo '<select name="pfb_status">';
    echo '<option value="">All statuses</option>';
    foreach (['open', 'needs_info', 'done'] as $opt) {
      printf(
        '<option value="%s"%s>%s</option>',
        esc_attr($opt),
        selected($status, $opt, false),
        esc_html($opt)
      );
    }
    echo '</select>';

    $selected_ip = isset($_GET['pfb_ip']) ? sanitize_text_field(wp_unslash($_GET['pfb_ip'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
    $ips = PFB_Notes::list_ips();
    if (!empty($ips)) {
      echo '<select name="pfb_ip">';
      echo '<option value="">All IPs</option>';
      foreach ($ips as $item) {
        printf(
          '<option value="%s"%s>%s (%d)</option>',
          esc_attr($item['ip']),
          selected($selected_ip, $item['ip'], false),
          esc_html($item['ip']),
          (int) $item['count']
        );
      }
      echo '</select>';
    }
  }

  public static function apply_filters(WP_Query $q) {
    if (!is_admin() || !$q->is_main_query() || $q->get('post_type') !== 'pfb_note') {
      return;
    }
    $status = isset($_GET['pfb_status']) ? sanitize_key(wp_unslash($_GET['pfb_status'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
    $ip = isset($_GET['pfb_ip']) ? sanitize_text_field(wp_unslash($_GET['pfb_ip'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended

    $meta = [];
    if ($status) {
      $meta[] = [
        'key' => '_pfb_status',
        'value' => $status,
      ];
    }
    if ($ip) {
      $meta[] = [
        'key' => '_pfb_ip',
        'value' => $ip,
      ];
    }
    if ($meta) {
      if (count($meta) > 1) {
        $meta['relation'] = 'AND';
      }
      $q->set('meta_query', $meta);
    }
  }

  public static function on_delete_post($post_id) {
    if (get_post_type($post_id) === 'pfb_note') {
      PFB_Notes::delete_note_attachments($post_id);
    }
  }
}
