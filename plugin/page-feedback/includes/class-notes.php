<?php
/**
 * Note storage helpers (CPT + media).
 *
 * @package PageFeedback
 */

if (!defined('ABSPATH')) {
  exit;
}

class PFB_Notes {
  public static function sanitize_slug($slug) {
    $slug = preg_replace('/[^a-z0-9\-_]+/i', '-', (string) $slug);
    $slug = trim((string) $slug, '-');
    return $slug !== '' ? strtolower($slug) : 'home';
  }

  public static function safe_entry_id($entry, $i) {
    $entry_id = !empty($entry['id'])
      ? preg_replace('/[^a-z0-9\-_]+/i', '', (string) $entry['id'])
      : (string) ($entry['ts'] ?? $i);
    if ($entry_id === '') {
      $entry_id = 'e' . $i . '-' . time();
    }
    return $entry_id;
  }

  public static function find_post_id($page_slug, $entry_id) {
    $posts = get_posts([
      'post_type' => 'pfb_note',
      'post_status' => 'any',
      'posts_per_page' => 1,
      'fields' => 'ids',
      'meta_query' => [
        'relation' => 'AND',
        [
          'key' => '_pfb_page',
          'value' => self::sanitize_slug($page_slug),
        ],
        [
          'key' => '_pfb_entry_id',
          'value' => $entry_id,
        ],
      ],
    ]);
    return $posts ? (int) $posts[0] : 0;
  }

  /**
   * @return array<int, array>
   */
  public static function load_page($slug) {
    $slug = self::sanitize_slug($slug);
    $posts = get_posts([
      'post_type' => 'pfb_note',
      'post_status' => ['publish', 'private'],
      'posts_per_page' => 200,
      'orderby' => 'date',
      'order' => 'ASC',
      'meta_key' => '_pfb_page',
      'meta_value' => $slug,
    ]);
    $out = [];
    foreach ($posts as $post) {
      $out[] = self::post_to_entry($post);
    }
    return $out;
  }

  public static function list_pages() {
    global $wpdb;
    $rows = $wpdb->get_results(
      "SELECT meta_value AS slug, COUNT(*) AS n
       FROM {$wpdb->postmeta} pm
       INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id
       WHERE pm.meta_key = '_pfb_page'
         AND p.post_type = 'pfb_note'
         AND p.post_status IN ('publish','private')
       GROUP BY meta_value
       ORDER BY meta_value ASC"
    );
    $pages = [];
    foreach ((array) $rows as $row) {
      $pages[] = [
        'slug' => (string) $row->slug,
        'count' => (int) $row->n,
      ];
    }
    return $pages;
  }

  public static function query_notes($args = []) {
    $q = [
      'post_type' => 'pfb_note',
      'post_status' => ['publish', 'private'],
      'posts_per_page' => isset($args['limit']) ? min(200, (int) $args['limit']) : 100,
      'orderby' => 'date',
      'order' => 'DESC',
    ];
    $meta = [];
    if (!empty($args['page'])) {
      $meta[] = [
        'key' => '_pfb_page',
        'value' => self::sanitize_slug($args['page']),
      ];
    }
    if (!empty($args['status'])) {
      $meta[] = [
        'key' => '_pfb_status',
        'value' => sanitize_key($args['status']),
      ];
    }
    if ($meta) {
      $q['meta_query'] = $meta;
    }
    $posts = get_posts($q);
    $out = [];
    foreach ($posts as $post) {
      $out[] = self::post_to_entry($post);
    }
    return $out;
  }

  public static function get_by_id($id) {
    $id = (int) $id;
    $post = $id ? get_post($id) : null;
    if (!$post || $post->post_type !== 'pfb_note') {
      return null;
    }
    return self::post_to_entry($post);
  }

  public static function get_by_entry_id($entry_id) {
    $posts = get_posts([
      'post_type' => 'pfb_note',
      'post_status' => 'any',
      'posts_per_page' => 1,
      'meta_key' => '_pfb_entry_id',
      'meta_value' => preg_replace('/[^a-z0-9\-_]+/i', '', (string) $entry_id),
    ]);
    return $posts ? self::post_to_entry($posts[0]) : null;
  }

  public static function post_to_entry(WP_Post $post) {
    $payload = get_post_meta($post->ID, '_pfb_payload', true);
    $entry = is_array($payload) ? $payload : [];
    $entry['wp_id'] = $post->ID;
    $entry['id'] = (string) get_post_meta($post->ID, '_pfb_entry_id', true);
    $entry['note'] = $post->post_content;
    $entry['page'] = (string) get_post_meta($post->ID, '_pfb_page', true);
    $entry['url'] = (string) get_post_meta($post->ID, '_pfb_url', true);
    $entry['selector'] = (string) get_post_meta($post->ID, '_pfb_selector', true);
    $entry['status'] = (string) get_post_meta($post->ID, '_pfb_status', true) ?: 'open';
    $entry['resolution'] = (string) get_post_meta($post->ID, '_pfb_resolution', true);
    $entry['question'] = (string) get_post_meta($post->ID, '_pfb_question', true);
    $entry['theme'] = (string) get_post_meta($post->ID, '_pfb_theme', true);
    $entry['scope'] = (string) get_post_meta($post->ID, '_pfb_scope', true) ?: 'element';
    $entry['snippet'] = (string) $post->post_excerpt;
    if (empty($entry['ts'])) {
      $entry['ts'] = (int) get_post_meta($post->ID, '_pfb_ts', true);
    }
    if (empty($entry['date'])) {
      $entry['date'] = get_gmt_from_date($post->post_date_gmt ?: $post->post_date, 'Y-m-d H:i:s') . ' UTC';
    }
    return $entry;
  }

  public static function upsert_entry($page_slug, $entry, $i = 0) {
    $page_slug = self::sanitize_slug($page_slug);
    $entry_id = self::safe_entry_id($entry, $i);
    $entry['id'] = $entry_id;
    if (empty($entry['ts'])) {
      $entry['ts'] = (int) round(microtime(true) * 1000);
    }
    if (empty($entry['date'])) {
      $entry['date'] = gmdate('Y-m-d H:i:s', (int) ($entry['ts'] / 1000)) . ' UTC';
    }

    $post_id = self::find_post_id($page_slug, $entry_id);
    $title = wp_strip_all_tags((string) ($entry['note'] ?? ''));
    $title = $title !== '' ? wp_html_excerpt($title, 80) : $entry_id;

    $data = [
      'post_type' => 'pfb_note',
      'post_status' => 'private',
      'post_title' => $title,
      'post_content' => wp_kses_post((string) ($entry['note'] ?? '')),
      'post_excerpt' => wp_strip_all_tags((string) ($entry['snippet'] ?? '')),
    ];

    if ($post_id) {
      $data['ID'] = $post_id;
      $saved = wp_update_post($data, true);
    } else {
      $saved = wp_insert_post($data, true);
    }
    if (is_wp_error($saved) || !$saved) {
      return is_wp_error($saved) ? $saved : new WP_Error('pfb_save', 'Could not save note.');
    }
    $post_id = (int) $saved;

    $entry = self::store_attachments($entry, $page_slug, $entry_id, $post_id);

    $status = sanitize_key((string) ($entry['status'] ?? 'open'));
    if (!in_array($status, ['open', 'done', 'needs_info'], true)) {
      $status = 'open';
    }

    update_post_meta($post_id, '_pfb_entry_id', $entry_id);
    update_post_meta($post_id, '_pfb_page', $page_slug);
    update_post_meta($post_id, '_pfb_url', sanitize_text_field((string) ($entry['url'] ?? '')));
    update_post_meta($post_id, '_pfb_selector', sanitize_text_field((string) ($entry['selector'] ?? '')));
    update_post_meta($post_id, '_pfb_status', $status);
    update_post_meta($post_id, '_pfb_resolution', wp_kses_post((string) ($entry['resolution'] ?? '')));
    update_post_meta($post_id, '_pfb_question', wp_kses_post((string) ($entry['question'] ?? '')));
    update_post_meta($post_id, '_pfb_theme', sanitize_text_field((string) ($entry['theme'] ?? '')));
    update_post_meta($post_id, '_pfb_scope', sanitize_key((string) ($entry['scope'] ?? 'element')));
    update_post_meta($post_id, '_pfb_ts', (int) $entry['ts']);
    update_post_meta($post_id, '_pfb_payload', $entry);

    $post = get_post($post_id);
    return $post ? self::post_to_entry($post) : $entry;
  }

  public static function delete_entry($page_slug, $entry_id) {
    $post_id = self::find_post_id($page_slug, $entry_id);
    if (!$post_id) {
      $found = self::get_by_entry_id($entry_id);
      $post_id = $found ? (int) $found['wp_id'] : 0;
    }
    if ($post_id) {
      wp_delete_post($post_id, true);
    }
    return (bool) $post_id;
  }

  public static function update_agent_fields($id_or_entry, $fields) {
    $entry = ctype_digit((string) $id_or_entry)
      ? self::get_by_id((int) $id_or_entry)
      : self::get_by_entry_id($id_or_entry);
    if (!$entry) {
      return new WP_Error('pfb_missing', 'Note not found.', ['status' => 404]);
    }
    $post_id = (int) $entry['wp_id'];
    if (isset($fields['status'])) {
      $status = sanitize_key((string) $fields['status']);
      if (in_array($status, ['open', 'done', 'needs_info'], true)) {
        $entry['status'] = $status;
        update_post_meta($post_id, '_pfb_status', $status);
        if ($status === 'done') {
          $entry['resolvedAt'] = gmdate('c');
        }
        if ($status === 'needs_info') {
          $entry['questionAt'] = gmdate('c');
        }
        if ($status === 'open') {
          $entry['reopenedAt'] = gmdate('c');
        }
      }
    }
    if (array_key_exists('resolution', $fields)) {
      $entry['resolution'] = wp_kses_post((string) $fields['resolution']);
      update_post_meta($post_id, '_pfb_resolution', $entry['resolution']);
    }
    if (array_key_exists('question', $fields)) {
      $entry['question'] = wp_kses_post((string) $fields['question']);
      update_post_meta($post_id, '_pfb_question', $entry['question']);
    }
    update_post_meta($post_id, '_pfb_payload', $entry);
    return self::get_by_id($post_id);
  }

  /**
   * Merge widget payload the same way the old theme JSON merge worked.
   *
   * @return array{ok:bool,count:int,entries:array}|WP_Error
   */
  public static function merge_and_save($slug, $incoming, $deleted_ids = []) {
    $slug = self::sanitize_slug($slug);
    $existing = [];
    foreach (self::load_page($slug) as $row) {
      if (!empty($row['id'])) {
        $existing[(string) $row['id']] = $row;
      }
    }

    $deleted = [];
    foreach ((array) $deleted_ids as $del_id) {
      $del_id = preg_replace('/[^a-z0-9\-_]+/i', '', (string) $del_id);
      if ($del_id === '') {
        continue;
      }
      $deleted[$del_id] = true;
      self::delete_entry($slug, $del_id);
      unset($existing[$del_id]);
    }

    $order = [];
    $merged = [];

    foreach ((array) $incoming as $i => $raw) {
      if (!is_array($raw)) {
        continue;
      }
      $id = self::safe_entry_id($raw, $i);
      $raw['id'] = $id;
      if (!empty($deleted[$id])) {
        continue;
      }
      if (isset($existing[$id])) {
        $prev = $existing[$id];
        foreach (['status', 'resolution', 'resolvedAt', 'question'] as $keep) {
          if (!empty($prev[$keep]) && empty($raw[$keep])) {
            $raw[$keep] = $prev[$keep];
          }
        }
        if (($prev['status'] ?? '') === 'done' && ($raw['status'] ?? '') === 'open' && empty($raw['reopenedAt'])) {
          $raw['status'] = 'done';
          if (!empty($prev['resolution'])) {
            $raw['resolution'] = $prev['resolution'];
          }
        }
        if (($prev['status'] ?? '') === 'needs_info' && ($raw['status'] ?? '') === 'open' && empty($raw['repliedAt'])) {
          $raw['status'] = 'needs_info';
          if (!empty($prev['question'])) {
            $raw['question'] = $prev['question'];
          }
        }
        unset($existing[$id]);
      }
      $saved = self::upsert_entry($slug, $raw, $i);
      if (is_wp_error($saved)) {
        return $saved;
      }
      $merged[$id] = $saved;
      $order[] = $id;
    }

    foreach ($existing as $id => $row) {
      $merged[$id] = $row;
      $order[] = $id;
    }

    $entries = [];
    foreach ($order as $id) {
      if (isset($merged[$id])) {
        $entries[] = $merged[$id];
        unset($merged[$id]);
      }
    }
    foreach ($merged as $row) {
      $entries[] = $row;
    }

    return [
      'ok' => true,
      'count' => count($entries),
      'entries' => $entries,
    ];
  }

  private static function store_attachments($entry, $slug, $entry_id, $parent_id = 0) {
    if (!empty($entry['images']) && is_array($entry['images'])) {
      foreach ($entry['images'] as $j => $img) {
        $url = self::store_data_image($img, $slug, $entry_id, $j, $parent_id);
        if ($url) {
          $entry['images'][$j] = $url;
        }
      }
    }
    if (!empty($entry['image']) && is_string($entry['image'])) {
      $url = self::store_data_image($entry['image'], $slug, $entry_id, 0, $parent_id);
      if ($url) {
        $entry['image'] = $url;
      }
    }
    if (!empty($entry['files']) && is_array($entry['files'])) {
      $stored = [];
      foreach ($entry['files'] as $j => $file) {
        $row = self::store_data_file($file, $slug, $entry_id, $j, $parent_id);
        if ($row) {
          $stored[] = $row;
        }
      }
      if ($stored) {
        $entry['files'] = $stored;
      } else {
        unset($entry['files']);
      }
    }
    return $entry;
  }

  private static function store_data_image($value, $slug, $entry_id, $index, $parent_id = 0) {
    if (!is_string($value) || strpos($value, 'data:image/') !== 0) {
      return $value;
    }
    if (!preg_match('/^data:image\/([a-z0-9.+-]+);base64,(.+)$/si', $value, $m)) {
      return $value;
    }
    $ext = strtolower($m[1]) === 'jpeg' ? 'jpg' : strtolower($m[1]);
    if (!in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'], true)) {
      $ext = 'jpg';
    }
    $bin = base64_decode($m[2], true);
    if ($bin === false || strlen($bin) > 8 * 1024 * 1024) {
      return $value;
    }
    $filename = $slug . '-' . $entry_id . ($index > 0 ? '-' . $index : '') . '.' . $ext;
    return self::sideload_bytes($bin, $filename, 'image/' . ($ext === 'jpg' ? 'jpeg' : $ext), $parent_id) ?: $value;
  }

  private static function store_data_file($file, $slug, $entry_id, $index, $parent_id = 0) {
    if (!is_array($file)) {
      return null;
    }
    $name = isset($file['name']) ? basename((string) $file['name']) : 'attachment';
    $name = preg_replace('/[^\w.\- ()\[\]]+/u', '_', $name);
    if (!empty($file['path']) && is_string($file['path']) && strpos($file['path'], 'data:') !== 0) {
      return ['name' => $name, 'path' => $file['path']];
    }
    $data = isset($file['data']) ? $file['data'] : '';
    if (!is_string($data) || strpos($data, 'data:') !== 0) {
      return null;
    }
    if (!preg_match('/^data:([^;,]+);base64,(.+)$/s', $data, $m)) {
      return null;
    }
    $bin = base64_decode($m[2], true);
    if ($bin === false || strlen($bin) === 0 || strlen($bin) > 8 * 1024 * 1024) {
      return null;
    }
    $ext = pathinfo($name, PATHINFO_EXTENSION);
    $ext = strtolower((string) $ext);
    if (!in_array($ext, ['doc', 'docx', 'pdf', 'txt', 'rtf'], true)) {
      return null;
    }
    $filename = $slug . '-' . $entry_id . '-file' . ($index > 0 ? '-' . $index : '') . '.' . $ext;
    $url = self::sideload_bytes($bin, $filename, $m[1], $parent_id);
    if (!$url) {
      return null;
    }
    return ['name' => $name, 'path' => $url];
  }

  private static function sideload_bytes($bin, $filename, $mime, $parent_id = 0) {
    $upload = wp_upload_bits($filename, null, $bin);
    if (!empty($upload['error']) || empty($upload['url'])) {
      return '';
    }
    $attachment = [
      'post_mime_type' => $mime,
      'post_title' => preg_replace('/\.[^.]+$/', '', $filename),
      'post_content' => '',
      'post_status' => 'inherit',
    ];
    $attach_id = wp_insert_attachment($attachment, $upload['file'], $parent_id);
    if (is_wp_error($attach_id) || !$attach_id) {
      return $upload['url'];
    }
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    $meta = wp_generate_attachment_metadata($attach_id, $upload['file']);
    if ($meta) {
      wp_update_attachment_metadata($attach_id, $meta);
    }
    return $upload['url'];
  }
}
