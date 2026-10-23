<?php
/* Receives feedback from feedback.js and writes feedback/<page>.json.
   Base64 images/docs are extracted to feedback/images/ and replaced with a path.
   IMPORTANT: merges by entry id. Client may send deletedIds[] to remove entries.
   Used when the preview is hosted on a PHP server. */
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

$raw = file_get_contents('php://input');
$data = json_decode($raw, true);

if (!is_array($data) || empty($data['page']) || !isset($data['entries']) || !is_array($data['entries'])) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Invalid payload']);
    exit;
}

$slug = preg_replace('/[^a-z0-9\-_]+/i', '-', $data['page']);
$slug = trim($slug, '-');
if ($slug === '') {
    $slug = 'index';
}

$imagesDir = __DIR__ . '/images';
if (!is_dir($imagesDir)) {
    mkdir($imagesDir, 0755, true);
}

$ALLOWED_IMAGE_EXT = ['jpg' => true, 'jpeg' => true, 'png' => true, 'gif' => true, 'webp' => true];
$ALLOWED_DOC_EXT = ['doc' => true, 'docx' => true, 'pdf' => true, 'txt' => true, 'rtf' => true];
$MAX_BYTES = 8 * 1024 * 1024;

function mtb_safe_entry_id($entry, $i)
{
    $entryId = !empty($entry['id'])
        ? preg_replace('/[^a-z0-9\-_]+/i', '', $entry['id'])
        : (string) ($entry['ts'] ?? $i);
    if ($entryId === '') {
        $entryId = 'e' . $i . '-' . time();
    }
    return $entryId;
}

function mtb_ext_from_mime($mime)
{
    $mime = strtolower((string) $mime);
    $map = [
        'jpeg' => 'jpg',
        'jpg' => 'jpg',
        'png' => 'png',
        'gif' => 'gif',
        'webp' => 'webp',
        'pdf' => 'pdf',
        'msword' => 'doc',
        'vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
        'plain' => 'txt',
        'rtf' => 'rtf',
    ];
    if (isset($map[$mime])) {
        return $map[$mime];
    }
    /* full mime like application/pdf */
    if (preg_match('#/(?:x-)?([a-z0-9.+-]+)$#', $mime, $m)) {
        $sub = strtolower($m[1]);
        if ($sub === 'jpeg') {
            return 'jpg';
        }
        if ($sub === 'msword') {
            return 'doc';
        }
        if (strpos($sub, 'wordprocessingml') !== false) {
            return 'docx';
        }
        if (in_array($sub, ['pdf', 'png', 'gif', 'webp', 'plain', 'rtf', 'doc', 'docx'], true)) {
            return $sub === 'plain' ? 'txt' : $sub;
        }
    }
    return '';
}

function mtb_ext_from_name($name)
{
    if (!is_string($name) || !preg_match('/\.([a-z0-9]+)$/i', $name, $m)) {
        return '';
    }
    return strtolower($m[1]);
}

/* Save one data-URL image to feedback/images/, return its path (or the
   original string if it is already a path / cannot be decoded). */
function mtb_store_image($value, $imagesDir, $slug, $entryId, $index)
{
    global $ALLOWED_IMAGE_EXT, $MAX_BYTES;

    if (!is_string($value) || strpos($value, 'data:image/') !== 0) {
        return $value; // already a path
    }
    if (!preg_match('/^data:image\/([a-z0-9.+-]+);base64,(.+)$/si', $value, $m)) {
        return $value;
    }
    $ext = mtb_ext_from_mime($m[1]);
    if ($ext === 'jpeg') {
        $ext = 'jpg';
    }
    if ($ext === '' || empty($ALLOWED_IMAGE_EXT[$ext])) {
        $ext = 'jpg';
    }
    $bin = base64_decode($m[2], true);
    if ($bin === false || strlen($bin) > $MAX_BYTES) {
        return $value;
    }
    $filename = $slug . '-' . $entryId . ($index > 0 ? '-' . $index : '') . '.' . $ext;
    if (file_put_contents($imagesDir . '/' . $filename, $bin) !== false) {
        return 'feedback/images/' . $filename;
    }
    return $value;
}

/* Save one document attachment object {name, data|path} → {name, path}. */
function mtb_store_file($file, $imagesDir, $slug, $entryId, $index)
{
    global $ALLOWED_DOC_EXT, $MAX_BYTES;

    if (!is_array($file)) {
        return null;
    }
    $name = isset($file['name']) ? basename((string) $file['name']) : 'attachment';
    $name = preg_replace('/[^\w.\- ()\[\]]+/u', '_', $name);
    if ($name === '' || $name === '.' || $name === '..') {
        $name = 'attachment';
    }

    /* Already saved */
    if (!empty($file['path']) && is_string($file['path']) && strpos($file['path'], 'data:') !== 0) {
        return [
            'name' => $name,
            'path' => $file['path'],
        ];
    }

    $data = isset($file['data']) ? $file['data'] : '';
    if (!is_string($data) || strpos($data, 'data:') !== 0) {
        return null;
    }
    if (!preg_match('/^data:([^;,]+);base64,(.+)$/s', $data, $m)) {
        return null;
    }
    $mime = strtolower($m[1]);
    $ext = mtb_ext_from_name($name);
    if ($ext === '' || empty($ALLOWED_DOC_EXT[$ext])) {
        $ext = mtb_ext_from_mime($mime);
    }
    if ($ext === '' || empty($ALLOWED_DOC_EXT[$ext])) {
        return null;
    }
    /* Ensure filename has the resolved extension */
    if (!preg_match('/\.' . preg_quote($ext, '/') . '$/i', $name)) {
        $name .= '.' . $ext;
    }

    $bin = base64_decode($m[2], true);
    if ($bin === false || strlen($bin) === 0 || strlen($bin) > $MAX_BYTES) {
        return null;
    }

    $filename = $slug . '-' . $entryId . '-file' . ($index > 0 ? '-' . $index : '') . '.' . $ext;
    if (file_put_contents($imagesDir . '/' . $filename, $bin) === false) {
        return null;
    }
    return [
        'name' => $name,
        'path' => 'feedback/images/' . $filename,
    ];
}

function mtb_process_entry($entry, $imagesDir, $slug, $i)
{
    if (!is_array($entry)) {
        return null;
    }
    $entryId = mtb_safe_entry_id($entry, $i);
    $entry['id'] = $entryId;

    /* Ensure human-readable date + theme are present */
    if (empty($entry['ts'])) {
        $entry['ts'] = (int) round(microtime(true) * 1000);
    }
    if (empty($entry['date'])) {
        $entry['date'] = gmdate('Y-m-d H:i:s', (int) ($entry['ts'] / 1000)) . ' UTC';
    }
    if (!isset($entry['theme'])) {
        $entry['theme'] = '';
    }

    if (!empty($entry['images']) && is_array($entry['images'])) {
        foreach ($entry['images'] as $j => $img) {
            $entry['images'][$j] = mtb_store_image($img, $imagesDir, $slug, $entryId, $j);
        }
    }
    if (!empty($entry['image']) && is_string($entry['image'])) {
        $entry['image'] = mtb_store_image($entry['image'], $imagesDir, $slug, $entryId, 0);
    }

    if (!empty($entry['files']) && is_array($entry['files'])) {
        $stored = [];
        foreach ($entry['files'] as $j => $file) {
            $row = mtb_store_file($file, $imagesDir, $slug, $entryId, $j);
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

/* Load existing file — never wipe history unless client sends deletedIds */
$file = __DIR__ . '/' . $slug . '.json';
$existing = [];
if (is_file($file)) {
    $prev = json_decode(file_get_contents($file), true);
    if (is_array($prev)) {
        foreach ($prev as $row) {
            if (is_array($row) && !empty($row['id'])) {
                $existing[(string) $row['id']] = $row;
            }
        }
    }
}

/* Explicit client deletes (widget Delete / Clear all) */
$deletedIds = [];
if (!empty($data['deletedIds']) && is_array($data['deletedIds'])) {
    foreach ($data['deletedIds'] as $delId) {
        $delId = preg_replace('/[^a-z0-9\-_]+/i', '', (string) $delId);
        if ($delId === '') {
            continue;
        }
        $deletedIds[$delId] = true;
        unset($existing[$delId]);
    }
}

/* Merge incoming: update/add by id; keep any existing id not in payload
   (unless it was listed in deletedIds). */
$incoming = $data['entries'];
$order = [];
$merged = [];

foreach ($incoming as $i => $rawEntry) {
    $processed = mtb_process_entry($rawEntry, $imagesDir, $slug, $i);
    if (!$processed) {
        continue;
    }
    $id = (string) $processed['id'];
    if (!empty($deletedIds[$id])) {
        continue; /* should not re-add a just-deleted id */
    }
    if (isset($existing[$id])) {
        /* Preserve agent resolution fields if client re-saves an older draft */
        $prev = $existing[$id];
        if (!empty($prev['status']) && empty($processed['status'])) {
            $processed['status'] = $prev['status'];
        }
        if (!empty($prev['resolution']) && empty($processed['resolution'])) {
            $processed['resolution'] = $prev['resolution'];
        }
        if (!empty($prev['resolvedAt']) && empty($processed['resolvedAt'])) {
            $processed['resolvedAt'] = $prev['resolvedAt'];
        }
        /* Preserve agent clarification question unless client clears it */
        if (!empty($prev['question']) && empty($processed['question'])) {
            $processed['question'] = $prev['question'];
        }
        if (($prev['status'] ?? '') === 'done' && ($processed['status'] ?? '') === 'open'
            && empty($processed['reopenedAt'])) {
            /* Keep done unless client explicitly reopened */
            $processed['status'] = 'done';
            if (!empty($prev['resolution'])) {
                $processed['resolution'] = $prev['resolution'];
            }
            if (!empty($prev['resolvedAt'])) {
                $processed['resolvedAt'] = $prev['resolvedAt'];
            }
        }
        /* needs_info → open only when client sent an explicit reply */
        if (($prev['status'] ?? '') === 'needs_info' && ($processed['status'] ?? '') === 'open'
            && empty($processed['repliedAt'])) {
            $processed['status'] = 'needs_info';
            if (!empty($prev['question'])) {
                $processed['question'] = $prev['question'];
            }
        }
        unset($existing[$id]);
    }
    $merged[$id] = $processed;
    $order[] = $id;
}

/* Append leftovers that were not in the client payload (unless deleted) */
foreach ($existing as $id => $row) {
    if (!empty($deletedIds[$id])) {
        continue;
    }
    if (empty($row['date']) && !empty($row['ts'])) {
        $row['date'] = gmdate('Y-m-d H:i:s', (int) ($row['ts'] / 1000)) . ' UTC';
    }
    if (!isset($row['theme'])) {
        $row['theme'] = '';
    }
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

$ok = file_put_contents(
    $file,
    json_encode($entries, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
);

echo json_encode([
    'ok' => $ok !== false,
    'file' => 'feedback/' . $slug . '.json',
    'count' => count($entries),
    'entries' => $entries,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
