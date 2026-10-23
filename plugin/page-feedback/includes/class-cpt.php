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
  }

  public static function apply_filters(WP_Query $q) {
    if (!is_admin() || !$q->is_main_query() || $q->get('post_type') !== 'pfb_note') {
      return;
    }
    $status = isset($_GET['pfb_status']) ? sanitize_key(wp_unslash($_GET['pfb_status'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
    if ($status) {
      $q->set('meta_key', '_pfb_status');
      $q->set('meta_value', $status);
    }
  }
}
