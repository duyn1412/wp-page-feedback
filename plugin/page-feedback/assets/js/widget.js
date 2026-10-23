/* Page Feedback widget — portable WordPress plugin.
   Click an element → highlight → comment + attachments.
   Drafts stay in localStorage until Save, then POST to /wp-json/pfb/v1/sync.
*/
(function () {
  var CFG = window.PFB || {};
  var ALLOW_NEW_FEEDBACK = String(CFG.allowNew) === "1";
  var LOGGED_IN = String(CFG.loggedIn) === "1";
  var LOGIN_URL = CFG.loginUrl || "";
  var REST_NONCE = CFG.nonce || "";

  function log() {
    var args = ["[PFB]"].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }
  log("script loaded", location.href, { allowNew: ALLOW_NEW_FEEDBACK, loggedIn: LOGGED_IN });

  var PAGE_SLUG = CFG.pageSlug || "home";
  var STORAGE_KEY = "pfb-feedback:" + PAGE_SLUG;
  var SYNC_URL = CFG.syncUrl || null;
  var FILE_URL = CFG.fileUrl || null;
  var MEDIA_BASE = CFG.mediaBase || "";

  var DIRTY_KEY = STORAGE_KEY + ":dirty";
  var DELETED_KEY = STORAGE_KEY + ":deleted";

  function loadDeleted() {
    try {
      var raw = localStorage.getItem(DELETED_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.map(String) : [];
    } catch (e) {
      return [];
    }
  }

  function saveDeleted(ids) {
    var uniq = [];
    var seen = {};
    (ids || []).forEach(function (id) {
      id = String(id || "");
      if (!id || seen[id]) return;
      seen[id] = true;
      uniq.push(id);
    });
    if (uniq.length) localStorage.setItem(DELETED_KEY, JSON.stringify(uniq));
    else localStorage.removeItem(DELETED_KEY);
  }

  function queueDeleteId(id) {
    if (!id) return;
    var ids = loadDeleted();
    id = String(id);
    if (ids.indexOf(id) < 0) ids.push(id);
    saveDeleted(ids);
  }

  function clearDeletedQueue() {
    localStorage.removeItem(DELETED_KEY);
  }

  log("init", { page: PAGE_SLUG, syncUrl: SYNC_URL, fileUrl: FILE_URL });

  /* ---------- storage ---------- */
  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (e) {
      return [];
    }
  }
  /* Local draft only — not final. "Save feedback" pushes to the server. */
  function save(entries) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    localStorage.setItem(DIRTY_KEY, "1");
    renderBadge();
    renderMarkers();
    renderSaveButton();
  }
  function isDirty() {
    return localStorage.getItem(DIRTY_KEY) === "1";
  }
  function clearDirty() {
    localStorage.removeItem(DIRTY_KEY);
    renderSaveButton();
  }

  /* Write the final list to redesign/feedback/<page>.json (PHP host / php -S).
     The server extracts base64 images to feedback/images/ and returns the
     processed entries (image = path), which replace the local copy.
     Success requires: HTTP OK + res.ok + entries array, then a GET of the
     JSON file confirming the file is readable (and ideally contains our ids). */
  function syncToServer(entries, onDone) {
    if (!SYNC_URL || location.protocol === "file:") {
      onDone && onDone(false, { error: "Save unavailable (open via https, not file://)." });
      return;
    }
    var sentIds = {};
    entries.forEach(function (e) {
      if (e && e.id) sentIds[String(e.id)] = true;
    });
    var deletedIds = loadDeleted();

    var headers = { "Content-Type": "application/json" };
    if (REST_NONCE) headers["X-WP-Nonce"] = REST_NONCE;
    fetch(SYNC_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: headers,
      body: JSON.stringify({
        page: PAGE_SLUG,
        entries: entries,
        deletedIds: deletedIds,
      }),
    })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            throw new Error("HTTP " + r.status + (t ? ": " + t.slice(0, 120) : ""));
          });
        }
        return r.json();
      })
      .then(function (res) {
        if (!res || res.ok !== true || !Array.isArray(res.entries)) {
          throw new Error("Server did not confirm save (invalid response).");
        }
        /* Persist merged server list locally */
        localStorage.setItem(STORAGE_KEY, JSON.stringify(res.entries));
        clearDeletedQueue();

        /* Validate by re-fetching the JSON file from disk/CDN */
        if (!FILE_URL) {
          return { res: res, verified: false };
        }
        return fetch(FILE_URL + (FILE_URL.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" })
          .then(function (r2) {
            if (!r2.ok) {
              throw new Error("Saved, but could not re-read " + PAGE_SLUG + ".json (HTTP " + r2.status + ").");
            }
            return r2.json().then(function (fileEntries) {
              if (!Array.isArray(fileEntries)) {
                throw new Error("Saved, but feedback file is not a valid list.");
              }
              var missing = [];
              Object.keys(sentIds).forEach(function (id) {
                var found = fileEntries.some(function (e) {
                  return e && String(e.id) === id;
                });
                if (!found) missing.push(id);
              });
              if (missing.length) {
                throw new Error(
                  "Save incomplete — " +
                    missing.length +
                    " note(s) missing from server file. Click Resave."
                );
              }
              var stillPresent = deletedIds.filter(function (id) {
                return fileEntries.some(function (e) {
                  return e && String(e.id) === String(id);
                });
              });
              if (stillPresent.length) {
                throw new Error(
                  "Delete incomplete — " +
                    stillPresent.length +
                    " note(s) still on server. Click Resave."
                );
              }
              return {
                res: res,
                verified: true,
                fileCount: fileEntries.length,
                file: res.file || ("feedback/" + PAGE_SLUG + ".json"),
              };
            });
          });
      })
      .then(function (info) {
        log("sync ok", info.file || (info.res && info.res.file), (info.res.entries || []).length + " entries", "verified=" + !!info.verified);
        onDone &&
          onDone(true, {
            count: (info.res.entries || []).length,
            file: info.file || (info.res && info.res.file) || ("feedback/" + PAGE_SLUG + ".json"),
            verified: !!info.verified,
            fileCount: info.fileCount,
          });
      })
      .catch(function (err) {
        log("sync failed", err);
        onDone && onDone(false, { error: (err && err.message) || "Network error" });
      });
  }

  /* Image/file can be a data URL (draft) or a repo path like "feedback/images/x.jpg" */
  function resolveImg(value) {
    if (!value) return "";
    if (typeof value !== "string") return "";
    if (value.indexOf("data:") === 0) return value;
    if (/^https?:\/\//i.test(value) || value.indexOf("/") === 0) return value;
    if (MEDIA_BASE) {
      try {
        return new URL(value.replace(/^\/+/, ""), MEDIA_BASE.replace(/\/?$/, "/") ).href;
      } catch (e) {
        return MEDIA_BASE + value;
      }
    }
    return value;
  }

  /* Entries may have "images" (array) or the legacy single "image" field */
  function imagesOf(entry) {
    if (Array.isArray(entry.images)) return entry.images;
    return entry.image ? [entry.image] : [];
  }

  /* Document attachments: [{ name, path|data }] — drafts use data, saved use path */
  function filesOf(entry) {
    return Array.isArray(entry.files) ? entry.files : [];
  }

  function resolveFileHref(file) {
    if (!file) return "";
    if (file.data && String(file.data).indexOf("data:") === 0) return file.data;
    if (file.path) return resolveImg(file.path);
    if (typeof file === "string") return resolveImg(file);
    return "";
  }

  var FILE_ACCEPT =
    "image/*,.doc,.docx,.pdf,.txt,.rtf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/plain";
  var MAX_ATTACH_BYTES = 8 * 1024 * 1024; /* 8 MB per file */
  var MAX_ATTACH_COUNT = 10;

  function extOfName(name) {
    var m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function isImageFile(file) {
    if (file && file.type && file.type.indexOf("image/") === 0) return true;
    return /^(jpe?g|png|gif|webp|bmp)$/i.test(extOfName(file && file.name));
  }

  function isDocFile(file) {
    var ext = extOfName(file && file.name);
    if (/^(doc|docx|pdf|txt|rtf)$/i.test(ext)) return true;
    var t = (file && file.type) || "";
    return (
      t === "application/msword" ||
      t === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      t === "application/pdf" ||
      t === "text/plain" ||
      t === "application/rtf" ||
      t === "text/rtf"
    );
  }

  function isAllowedAttach(file) {
    return isImageFile(file) || isDocFile(file);
  }

  /* Empty dirty draft blocks the server pull — heal it (common stuck state). */
  function healEmptyDirty() {
    if (isDirty() && load().length === 0) {
      log("heal: clearing empty dirty draft so server feedback can load");
      clearDirty();
      try {
        localStorage.setItem(STORAGE_KEY, "[]");
      } catch (e) {}
      return true;
    }
    return false;
  }

  /* Merge server list with local drafts: server first, local ids override,
     then append local-only new notes. Never drop server entries. */
  function mergeFeedbackLists(serverEntries, localEntries) {
    var deleted = {};
    loadDeleted().forEach(function (id) {
      deleted[String(id)] = true;
    });
    var byId = {};
    var order = [];
    (serverEntries || []).forEach(function (e) {
      if (!e || !e.id) return;
      var id = String(e.id);
      if (deleted[id]) return; /* pending client deletes win until Save */
      byId[id] = e;
      order.push(id);
    });
    (localEntries || []).forEach(function (e) {
      if (!e || !e.id) return;
      var id = String(e.id);
      if (deleted[id]) return;
      if (!byId[id]) {
        order.push(id);
        byId[id] = e;
      } else {
        var s = byId[id];
        /* If server marked done, keep done unless client explicitly reopened */
        if (s.status === "done" && e.status !== "done" && !e.reopenedAt) {
          e.status = "done";
          if (s.resolution && !e.resolution) e.resolution = s.resolution;
          if (s.resolvedAt && !e.resolvedAt) e.resolvedAt = s.resolvedAt;
        }
        if (s.status === "needs_info" && s.question && !e.repliedAt) {
          e.status = "needs_info";
          e.question = s.question;
        }
        byId[id] = Object.assign({}, s, e);
      }
    });
    return order.map(function (id) {
      return byId[id];
    });
  }

  /* On page load: always pull the server JSON. If local has unsaved drafts,
     merge them on top (empty dirty drafts are cleared first). */
  function pullFromServer(cb) {
    if (!FILE_URL || location.protocol === "file:") {
      log("pull skipped", { fileUrl: FILE_URL, page: PAGE_SLUG });
      cb();
      return;
    }
    healEmptyDirty();
    var dirty = isDirty();
    var localSnapshot = dirty ? load().slice() : [];

    var pullHeaders = { Accept: "application/json" };
    if (REST_NONCE) pullHeaders["X-WP-Nonce"] = REST_NONCE;
    fetch(FILE_URL + (FILE_URL.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now(), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
      headers: pullHeaders,
    })
      .then(function (r) {
        var ctype = (r.headers.get("content-type") || "").toLowerCase();
        /* Missing files may 301 to a WordPress HTML page (still HTTP 200).
           Only accept real JSON arrays so we never wipe the panel with HTML. */
        if (!r.ok) {
          log("pull http", r.status, FILE_URL);
          return null;
        }
        if (ctype.indexOf("json") === -1 && ctype.indexOf("text/plain") === -1) {
          log("pull not json", ctype || "(no content-type)", FILE_URL);
          return null;
        }
        return r.json().then(function (data) {
          return Array.isArray(data) ? data : null;
        });
      })
      .then(function (serverEntries) {
        if (serverEntries == null) {
          log("pull skipped apply (no valid JSON)", { page: PAGE_SLUG, fileUrl: FILE_URL });
          cb();
          return;
        }
        if (dirty && localSnapshot.length) {
          var merged = mergeFeedbackLists(serverEntries, localSnapshot);
          log("pulled+merged", {
            page: PAGE_SLUG,
            server: serverEntries.length,
            local: localSnapshot.length,
            merged: merged.length,
          });
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
          /* keep dirty so client still clicks Save/Resave for local-only notes */
        } else {
          log("pulled from server", PAGE_SLUG, serverEntries.length + " entries");
          localStorage.setItem(STORAGE_KEY, JSON.stringify(serverEntries));
          if (dirty) clearDirty();
        }
        cb();
      })
      .catch(function (err) {
        log("pull failed", PAGE_SLUG, err);
        cb();
      });
  }

  /* ---------- selector generation ---------- */
  function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var path = [];
    while (el && el.nodeType === 1 && el.tagName !== "BODY" && el.tagName !== "HTML") {
      var sel = el.tagName.toLowerCase();
      var cls = Array.prototype.slice
        .call(el.classList)
        .filter(function (c) {
          return (
            c.indexOf("fb-") !== 0 &&
            c !== "is-active" &&
            c !== "is-visible" &&
            !/^(post|page|term|tag|category)-\d+$/.test(c)
          );
        })
        .slice(0, 2);
      if (cls.length) sel += "." + cls.map(CSS.escape).join(".");
      var parent = el.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (s) {
          return s.tagName === el.tagName;
        });
        if (same.length > 1) {
          sel += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
        }
      }
      path.unshift(sel);
      if (el.id) {
        path[0] = "#" + CSS.escape(el.id);
        break;
      }
      el = parent;
    }
    return path.join(" > ");
  }

  /* Resilient selector resolver: handles WordPress dynamic classes, DOM shifts */
  function resolveTargetElement(sel) {
    if (!sel || sel === "(global)") return null;
    var el = null;
    try {
      el = document.querySelector(sel);
    } catch (e) {}
    if (el) return el;

    /* Fallback 1: strip dynamic WordPress ID classes (.post-1234, .term-5, etc.) */
    var stripped = sel.replace(/\.(post|page|term|tag|category)-\d+/g, "");
    if (stripped !== sel) {
      try {
        el = document.querySelector(stripped);
      } catch (e) {}
      if (el) return el;
    }

    /* Fallback 2: strip :nth-of-type pseudo selectors */
    var noNth = stripped.replace(/:nth-of-type\(\d+\)/g, "");
    if (noNth !== stripped) {
      try {
        el = document.querySelector(noNth);
      } catch (e) {}
      if (el) return el;
    }

    /* Fallback 3: locate by innermost element selector */
    var parts = sel.split(" > ");
    if (parts.length > 1) {
      var lastPart = parts[parts.length - 1].replace(/\.(post|page|term|tag|category)-\d+/g, "");
      try {
        el = document.querySelector(lastPart);
      } catch (e) {}
      if (el) return el;
    }

    return null;
  }

  /* ---------- styles ---------- */
  var css = "";
  css += ".fb-dock{position:fixed;right:1rem;bottom:1rem;z-index:9999;display:flex;align-items:center;gap:.5rem;}";
  css += ".fb-toggle{display:inline-flex;align-items:center;gap:.5rem;padding:.6rem 1rem;border:0;border-radius:999px;background:#0b1220;color:#fff;font:600 13px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.35);}";
  css += ".fb-savebtn{display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1rem;border:0;border-radius:999px;background:#9aa4b2;color:#fff;font:600 13px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.2);}";
  css += ".fb-savebtn.fb-dirty{background:#1d8843;}";
  css += ".fb-savebtn.fb-ok{background:#1d8843;}";
  css += ".fb-savebtn.fb-err{background:#e04545;}";
  css += ".fb-savebtn:disabled{opacity:.85;cursor:default;}";
  css += ".fb-toast{position:fixed;left:50%;bottom:5.5rem;transform:translateX(-50%);z-index:10001;max-width:min(420px,92vw);padding:.75rem 1.1rem;border-radius:12px;font:600 13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 12px 32px rgba(0,0,0,.28);pointer-events:none;opacity:0;transition:opacity .2s ease;}";
  css += ".fb-toast.fb-show{opacity:1;}";
  css += ".fb-toast.fb-ok{background:#1d8843;}";
  css += ".fb-toast.fb-err{background:#e04545;}";
  css += ".fb-globalbtn{display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1rem;border:1.5px solid #0b1220;border-radius:999px;background:#fff;color:#0b1220;font:600 13px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.18);}";
  css += ".fb-frozen{display:inline-flex;align-items:center;gap:.4rem;padding:.55rem .9rem;border-radius:999px;background:#fff8e8;border:1px solid #f0d78a;color:#6b4e00;font:600 12px/1.3 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.12);max-width:min(280px,70vw);}";
  css += ".fb-globalbtn:hover{background:#0b1220;color:#fff;}";
  css += ".fb-form-global{position:fixed;top:18vh;left:50%;transform:translateX(-50%);width:min(400px,92vw);}";
  css += ".fb-scope{display:inline-block;padding:.1em .5em;border-radius:999px;font:700 9.5px/1.5 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em;vertical-align:1px;margin-right:.3em;background:#eef2fb;color:#003b95;}";
  css += ".fb-toggle .fb-count{display:inline-flex;align-items:center;justify-content:center;min-width:1.3em;height:1.3em;padding:0 .3em;border-radius:999px;background:#e04545;font-size:11px;}";
  css += ".fb-toggle.fb-on{background:#e04545;}";
  css += "body.fb-mode, body.fb-mode *{cursor:crosshair!important;}";
  css += ".fb-hover-box{position:absolute;z-index:9997;pointer-events:none;border:2px dashed #e04545;background:rgba(224,69,69,.08);border-radius:4px;}";
  css += ".fb-selected-box{position:absolute;z-index:9997;pointer-events:none;border:2px solid #e04545;background:rgba(224,69,69,.12);border-radius:4px;}";
  css += ".fb-form{position:absolute;z-index:9999;width:min(320px,90vw);background:#fff;border:1px solid #d5dce8;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.25);padding: .85rem;font:400 13px/1.45 system-ui,sans-serif;color:#121826;}";
  css += ".fb-form .fb-sel{font:600 11px/1.3 ui-monospace,monospace;color:#5a6578;word-break:break-all;margin:0 0 .5rem;}";
  css += ".fb-form textarea{width:100%;box-sizing:border-box;min-height:70px;padding:.5rem .6rem;border:1px solid #d5dce8;border-radius:8px;font:inherit;resize:vertical;}";
  css += ".fb-form .fb-row{display:flex;gap:.5rem;justify-content:flex-end;margin-top:.6rem;}";
  css += ".fb-form button{padding:.42rem .85rem;border-radius:8px;border:1px solid #d5dce8;background:#fff;font:600 12px system-ui,sans-serif;cursor:pointer;}";
  css += ".fb-form button.fb-save{background:#e04545;border-color:#e04545;color:#fff;}";
  css += ".fb-marker{position:fixed;z-index:9998;width:28px;height:28px;border-radius:999px;background:#e04545;color:#fff;border:2px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.3);font:700 13px/24px system-ui,sans-serif;text-align:center;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease;}";
  css += ".fb-marker:hover{transform:scale(1.15);box-shadow:0 4px 14px rgba(0,0,0,.4);}";
  css += ".fb-marker.fb-marker-needs{background:#c99200;}";
  css += ".fb-marker.fb-marker-done{background:#1d8843;border-color:#fff;color:#fff;}";
  css += ".fb-marker.fb-marker-done:hover{background:#157335;box-shadow:0 4px 14px rgba(29,136,67,.5);}";
  css += ".fb-panel{position:fixed;right:1rem;bottom:3.6rem;z-index:9999;width:min(360px,92vw);max-height:min(60vh,480px);overflow:auto;background:#fff;border:1px solid #d5dce8;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.3);font:400 13px/1.45 system-ui,sans-serif;color:#121826;display:none;}";
  css += ".fb-panel.fb-open{display:block;}";
  css += ".fb-panel-head{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.7rem .85rem;background:#fff;border-bottom:1px solid #eef1f6;font-weight:700;}";
  css += ".fb-panel-head .fb-actions{display:flex;gap:.4rem;}";
  css += ".fb-panel-head button{padding:.32rem .6rem;border-radius:7px;border:1px solid #d5dce8;background:#fff;font:600 11px system-ui,sans-serif;cursor:pointer;}";
  css += ".fb-item{padding:.65rem .85rem;border-bottom:1px solid #eef1f6;}";
  css += ".fb-item .fb-item-sel{font:600 10.5px/1.35 ui-monospace,monospace;color:#5a6578;word-break:break-all;}";
  css += ".fb-item .fb-item-note{margin:.3rem 0 .35rem;white-space:pre-wrap;}";
  css += ".fb-item .fb-item-meta{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#8a94a6;}";
  css += ".fb-item .fb-del{border:0;background:none;color:#e04545;font:600 11px system-ui,sans-serif;cursor:pointer;padding:0;}";
  css += ".fb-item .fb-edit{border:0;background:none;color:#003b95;font:600 11px system-ui,sans-serif;cursor:pointer;padding:0;}";
  css += ".fb-item-actions{display:inline-flex;align-items:center;gap:.65em;}";
  css += ".fb-panel-head button[data-fb-clear-all]{color:#e04545;border-color:#f3c4c4;}";
  css += ".fb-item .fb-edit-ta{width:100%;box-sizing:border-box;min-height:60px;margin-top:.3rem;padding:.45rem .55rem;border:1px solid #d5dce8;border-radius:8px;font:inherit;resize:vertical;}";
  css += ".fb-empty{padding:1rem .85rem;color:#8a94a6;}";
  css += ".fb-attach{display:flex;align-items:center;gap:.5rem;margin-top:.55rem;flex-wrap:wrap;}";
  css += ".fb-attach input[type=file]{display:none;}";
  css += ".fb-attach .fb-attach-btn{padding:.38rem .7rem;border-radius:8px;border:1px dashed #d5dce8;background:#f8fafc;font:600 11.5px system-ui,sans-serif;color:#5a6578;cursor:pointer;}";
  css += ".fb-attach .fb-attach-btn:hover{border-color:#e04545;color:#e04545;}";
  css += ".fb-attach-hint{font-size:10.5px;color:#8a94a6;width:100%;margin:0;}";
  css += ".fb-preview{position:relative;display:none;margin-top:.55rem;}";
  css += ".fb-preview img{display:block;max-width:100%;max-height:140px;border-radius:8px;border:1px solid #d5dce8;}";
  css += ".fb-preview .fb-remove-img{position:absolute;top:-7px;right:-7px;width:20px;height:20px;border-radius:999px;border:0;background:#0b1220;color:#fff;font:700 11px/20px system-ui,sans-serif;cursor:pointer;padding:0;}";
  css += ".fb-file-chip{position:relative;display:flex;align-items:center;gap:.45rem;margin-top:.45rem;padding:.45rem .55rem;border:1px solid #eef1f6;border-radius:8px;background:#f8fafc;font:600 12px/1.35 system-ui,sans-serif;color:#121826;text-decoration:none;}";
  css += ".fb-file-chip:hover{border-color:#c5d0e0;}";
  css += ".fb-file-chip .fb-file-icon{flex:0 0 auto;width:1.5rem;height:1.5rem;border-radius:5px;background:#003b95;color:#fff;font:700 9px/1.5rem system-ui,sans-serif;text-align:center;}";
  css += ".fb-file-chip .fb-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}";
  css += ".fb-file-chip .fb-remove-img{position:static;margin-left:auto;}";
  css += ".fb-item .fb-item-img{display:block;max-width:100%;max-height:120px;border-radius:8px;border:1px solid #eef1f6;margin:.15rem 0 .35rem;cursor:zoom-in;}";
  css += ".fb-item .fb-item-file{display:flex;margin:.15rem 0 .35rem;}";
  css += ".fb-status{display:inline-block;padding:.1em .5em;border-radius:999px;font:700 9.5px/1.5 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.04em;vertical-align:1px;margin-right:.3em;}";
  css += ".fb-status-open{background:#fdecec;color:#e04545;}";
  css += ".fb-status-done{background:#e7f6ec;color:#1d8843;}";
  css += ".fb-status-needs{background:#fff4d6;color:#9a6b00;}";
  css += ".fb-count-done{background:#e7f6ec;color:#1d8843;}";
  css += ".fb-count-needs{background:#fff4d6;color:#9a6b00;}";
  css += ".fb-page-slug{font-weight:500;color:#6b7280;font-size:11px;}";
  css += ".fb-item.fb-done .fb-item-note{color:#8a94a6;}";
  css += ".fb-item.fb-needs{background:#fffbeb;}";
  css += ".fb-item .fb-item-res{margin:0 0 .35rem;padding:.35rem .5rem;background:#f4f9f5;border-radius:7px;font-size:12px;color:#1d8843;}";
  css += ".fb-item .fb-item-ask{margin:.35rem 0;padding:.45rem .55rem;background:#fff4d6;border:1px solid #f0d78a;border-radius:7px;font-size:12px;color:#6b4e00;white-space:pre-wrap;}";
  css += ".fb-item .fb-item-ask strong{display:block;margin-bottom:.2rem;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:#9a6b00;}";
  css += ".fb-item .fb-reply{border:0;background:none;color:#9a6b00;font:600 11px system-ui,sans-serif;cursor:pointer;padding:0;}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------- attachment helpers: images compressed; docs as data URLs ---------- */
  function fileToDataUrl(file, cb) {
    if (!file) {
      cb(null);
      return;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      showToast("File too large (max 8 MB): " + (file.name || "file"), "err");
      cb(null);
      return;
    }
    if (!isAllowedAttach(file)) {
      showToast("Unsupported file type. Use images, DOC, DOCX, PDF, or TXT.", "err");
      cb(null);
      return;
    }
    if (isImageFile(file)) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var MAX = 1200;
          var scale = Math.min(1, MAX / Math.max(img.width, img.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          cb({ kind: "image", data: canvas.toDataURL("image/jpeg", 0.8) });
        };
        img.onerror = function () {
          cb(null);
        };
        img.src = reader.result;
      };
      reader.onerror = function () {
        cb(null);
      };
      reader.readAsDataURL(file);
      return;
    }
    var docReader = new FileReader();
    docReader.onload = function () {
      cb({
        kind: "file",
        name: file.name || "attachment." + (extOfName(file.name) || "bin"),
        data: docReader.result,
      });
    };
    docReader.onerror = function () {
      cb(null);
    };
    docReader.readAsDataURL(file);
  }

  function fileChipHtml(file, opts) {
    opts = opts || {};
    var name = (file && file.name) || "Document";
    var ext = (extOfName(name) || "FILE").toUpperCase().slice(0, 4);
    var href = resolveFileHref(file);
    var rm =
      opts.rmAttr != null
        ? '<button type="button" class="fb-remove-img" ' +
          opts.rmAttr +
          ' title="Remove file">✕</button>'
        : "";
    var inner =
      '<span class="fb-file-icon">' +
      ext +
      '</span><span class="fb-file-name">' +
      String(name).replace(/</g, "&lt;") +
      "</span>" +
      rm;
    if (href && !opts.noLink) {
      return (
        '<a class="fb-file-chip' +
        (opts.itemClass ? " " + opts.itemClass : "") +
        '" href="' +
        href +
        '" download="' +
        String(name).replace(/"/g, "") +
        '" target="_blank" rel="noopener">' +
        inner +
        "</a>"
      );
    }
    return (
      '<div class="fb-file-chip' +
      (opts.itemClass ? " " + opts.itemClass : "") +
      '">' +
      inner +
      "</div>"
    );
  }

  /* ---------- UI elements ---------- */
  var mode = false;
  var hoverBox = null;
  var formEl = null;
  var markers = [];

  var dock = document.createElement("div");
  dock.className = "fb-dock";
  dock.setAttribute("data-fb-ui", "");
  document.body.appendChild(dock);

  var saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "fb-savebtn";
  saveBtn.setAttribute("data-fb-ui", "");
  saveBtn.textContent = "Save feedback";
  dock.appendChild(saveBtn);

  var toastEl = document.createElement("div");
  toastEl.className = "fb-toast";
  toastEl.setAttribute("data-fb-ui", "");
  document.body.appendChild(toastEl);
  var toastTimer = null;
  function showToast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = "fb-toast fb-show" + (kind ? " fb-" + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("fb-show");
    }, 4500);
  }

  var globalBtn = document.createElement("button");
  globalBtn.type = "button";
  globalBtn.className = "fb-globalbtn";
  globalBtn.setAttribute("data-fb-ui", "");
  globalBtn.textContent = "🌐 General feedback";
  if (ALLOW_NEW_FEEDBACK) {
    dock.appendChild(globalBtn);
    globalBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openForm({ global: true });
    });
  } else {
    var frozenNote = document.createElement("div");
    frozenNote.className = "fb-frozen";
    frozenNote.setAttribute("data-fb-ui", "");
    frozenNote.textContent = LOGGED_IN
      ? "Adding notes is paused — view existing only"
      : "Log in to leave notes";
    frozenNote.title = LOGGED_IN
      ? "An editor paused new notes. Existing notes stay available."
      : "Sign in to add or save feedback on this page.";
    if (!LOGGED_IN && LOGIN_URL) {
      frozenNote.style.cursor = "pointer";
      frozenNote.addEventListener("click", function () {
        location.href = LOGIN_URL;
      });
    }
    dock.appendChild(frozenNote);
  }

  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fb-toggle";
  toggle.setAttribute("data-fb-ui", "");
  dock.appendChild(toggle);

  log("dock mounted", {
    buttons: dock.children.length,
    inBody: document.body.contains(dock),
  });

  var saving = false;

  /* Dirty → Save feedback; clean → Resave (always available for the client) */
  function renderSaveButton() {
    if (saving) return;
    var dirty = isDirty();
    var n = load().length;
    var pendingDeletes = loadDeleted().length;
    saveBtn.classList.remove("fb-ok", "fb-err");
    saveBtn.classList.toggle("fb-dirty", dirty);
    saveBtn.disabled = false;
    if (dirty) {
      saveBtn.textContent =
        pendingDeletes && !n ? "Save deletions" : "Save feedback";
      saveBtn.title = "Upload unsaved notes / deletions to the server";
    } else if (n) {
      saveBtn.textContent = "Resave";
      saveBtn.title = "Re-upload all notes and verify they are on the server";
    } else {
      saveBtn.textContent = "Save feedback";
      saveBtn.title = "No notes yet";
      saveBtn.disabled = true;
    }
  }

  function submitFinal() {
    var entries = load();
    var deletedIds = loadDeleted();
    if (!entries.length && !deletedIds.length) {
      showToast("No feedback to save yet.", "err");
      renderSaveButton();
      return;
    }
    saving = true;
    saveBtn.disabled = true;
    saveBtn.classList.remove("fb-ok", "fb-err", "fb-dirty");
    saveBtn.textContent = "Saving…";
    syncToServer(entries, function (ok, info) {
      saving = false;
      if (ok) {
        clearDirty();
        renderBadge();
        renderMarkers();
        if (panel.classList.contains("fb-open")) renderPanel();
        saveBtn.classList.add("fb-ok");
        saveBtn.textContent = "Saved ✓";
        var msg =
          "Saved " +
          (info && info.count != null ? info.count : entries.length) +
          " note(s) to " +
          ((info && info.file) || ("feedback/" + PAGE_SLUG + ".json"));
        if (info && info.verified) {
          msg += " — verified on server.";
        } else {
          msg += " — server confirmed.";
        }
        showToast(msg, "ok");
        setTimeout(renderSaveButton, 2200);
      } else {
        saveBtn.classList.add("fb-err");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save failed — retry";
        showToast(
          "Save failed: " + ((info && info.error) || "unknown error") + " Click Resave.",
          "err"
        );
        setTimeout(renderSaveButton, 3200);
      }
    });
  }

  saveBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (saving) return;
    submitFinal();
  });

  var panel = document.createElement("div");
  panel.className = "fb-panel";
  panel.setAttribute("data-fb-ui", "");
  document.body.appendChild(panel);

  function renderBadge() {
    var entries = load();
    var needs = entries.filter(function (e) {
      return e.status === "needs_info";
    }).length;
    var open = entries.filter(function (e) {
      return e.status === "open" || e.status === "needs_info";
    }).length;
    var total = entries.length;
    var label = mode ? "Feedback: ON" : "Feedback";
    if (!ALLOW_NEW_FEEDBACK) label = "View feedback";
    var countHtml = "";
    if (needs) {
      countHtml =
        ' <span class="fb-count fb-count-needs" title="' +
        needs +
        " need your reply / " +
        open +
        " active / " +
        total +
        ' on this page">' +
        needs +
        "?</span>";
    } else if (open) {
      countHtml =
        ' <span class="fb-count" title="' +
        open +
        " open / " +
        total +
        ' on this page">' +
        open +
        "</span>";
    } else if (total) {
      countHtml =
        ' <span class="fb-count fb-count-done" title="' +
        total +
        ' notes on this page (all done)">' +
        total +
        "</span>";
    }
    toggle.innerHTML = label + countHtml;
    toggle.title = ALLOW_NEW_FEEDBACK
      ? "Page file: " +
        PAGE_SLUG +
        (total ? " · " + total + " notes" : "") +
        (needs ? " · " + needs + " need your reply" : "")
      : "View existing notes only. Page: " +
        PAGE_SLUG +
        (total ? " · " + total + " notes" : "");
    toggle.classList.toggle("fb-on", mode && ALLOW_NEW_FEEDBACK);
  }

  /* ---------- markers ---------- */
  function clearMarkers() {
    markers.forEach(function (m) {
      m.remove();
    });
    markers = [];
  }

  /* Markers use position:fixed and follow their target element every frame,
     so they stay glued to the element during scroll and reveal animations. */
  function positionMarker(m) {
    var el = m._fbTarget;
    if (!el || !el.isConnected) {
      m.style.display = "none";
      return;
    }
    var r = el.getBoundingClientRect();
    /* hidden elements (submenus, collapsed content, …) */
    if (r.width === 0 && r.height === 0) {
      m.style.display = "none";
      return;
    }
    m.style.display = "";
    m.style.left = r.right - 14 + "px";
    m.style.top = r.top - 14 + "px";
  }

  function positionAllMarkers() {
    markers.forEach(positionMarker);
  }

  function renderMarkers() {
    clearMarkers();
    load().forEach(function (entry, i) {
      var el = resolveTargetElement(entry.selector);
      if (!el) return;
      var isDone = entry.status === "done";
      var isNeeds = entry.status === "needs_info";
      var m = document.createElement("button");
      m.type = "button";
      m.className =
        "fb-marker" +
        (isDone ? " fb-marker-done" : isNeeds ? " fb-marker-needs" : "");
      m.setAttribute("data-fb-ui", "");
      m.textContent = i + 1;
      m.title = isDone
        ? "✓ Done (#" + (i + 1) + "): " + (entry.note || "") + (entry.resolution ? "\n→ " + entry.resolution : "") + "\n(Click to view / reopen)"
        : isNeeds && entry.question
          ? "Needs your reply (#" + (i + 1) + "): " + entry.question
          : "#" + (i + 1) + ": " + (entry.note || "");
      m._fbTarget = el;
      /* Click a marker → open the panel with that entry */
      m.addEventListener("click", function (e) {
        e.stopPropagation();
        openPanel();
        if (isDone) {
          stopEdit();
          renderPanel();
          var itemEl = panel.querySelectorAll(".fb-item")[i];
          if (itemEl) {
            itemEl.scrollIntoView({ block: "center", behavior: "smooth" });
            itemEl.style.transition = "outline .2s ease, box-shadow .2s ease";
            itemEl.style.outline = "2px solid #1d8843";
            itemEl.style.outlineOffset = "2px";
            setTimeout(function () {
              itemEl.style.outline = "";
              itemEl.style.outlineOffset = "";
            }, 3000);
            var reopenBtn = itemEl.querySelector("[data-fb-reopen]");
            if (reopenBtn) reopenBtn.focus();
          }
        } else {
          startEdit(i);
          renderPanel();
          var ta = panel.querySelector(".fb-edit-ta");
          if (ta) {
            ta.scrollIntoView({ block: "center", behavior: "smooth" });
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          }
        }
      });
      document.body.appendChild(m);
      markers.push(m);
      positionMarker(m);
    });
    log("markers rendered", markers.length + "/" + load().length);
  }

  /* rAF-throttled repositioning: smooth during scroll, cheap when idle */
  var rafPending = false;
  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      positionAllMarkers();
    });
  }
  window.addEventListener("scroll", scheduleReposition, { passive: true });
  window.addEventListener("resize", scheduleReposition);
  window.addEventListener("load", function () {
    renderMarkers();
    /* late layout shifts: webfonts, lazy images */
    setTimeout(positionAllMarkers, 1200);
    setTimeout(positionAllMarkers, 3000);
  });
  /* reveal/hover transitions move elements — track them while they animate */
  document.addEventListener("transitionend", scheduleReposition, true);
  document.addEventListener("animationend", scheduleReposition, true);

  /* ---------- panel ---------- */
  function openPanel() {
    renderPanel();
    panel.classList.add("fb-open");
  }
  function closePanel() {
    panel.classList.remove("fb-open");
  }

  var editingIndex = -1;
  /* Pending changes while editing: note/images/files = undefined → untouched */
  var editingDraft = null;

  function startEdit(i) {
    editingIndex = i;
    editingDraft = { note: undefined, images: undefined, files: undefined };
  }
  function stopEdit() {
    editingIndex = -1;
    editingDraft = null;
  }
  /* Keep typed text across re-renders (e.g. after attaching a file) */
  function captureDraftNote() {
    var ta = panel.querySelector(".fb-edit-ta");
    if (ta && editingDraft) editingDraft.note = ta.value;
  }

  function ensureDraftImages() {
    if (!editingDraft) return [];
    if (editingDraft.images === undefined) {
      var cur = load()[editingIndex];
      editingDraft.images = cur ? imagesOf(cur).slice() : [];
    }
    return editingDraft.images;
  }

  function ensureDraftFiles() {
    if (!editingDraft) return [];
    if (editingDraft.files === undefined) {
      var cur = load()[editingIndex];
      editingDraft.files = cur ? filesOf(cur).map(function (f) {
        return Object.assign({}, f);
      }) : [];
    }
    return editingDraft.files;
  }

  function draftAttachCount() {
    return ensureDraftImages().length + ensureDraftFiles().length;
  }

  function renderPanel() {
    var entries = load();
    var head =
      '<div class="fb-panel-head"><span>Feedback (' +
      entries.length +
      ')<small class="fb-page-slug" title="Server file for this URL"> · ' +
      PAGE_SLUG +
      '.json</small></span><span class="fb-actions">' +
      (isDirty()
        ? '<button type="button" data-fb-sync style="background:#1d8843;border-color:#1d8843;color:#fff">Save</button>'
        : '<button type="button" data-fb-sync>Resave</button>') +
      (entries.length
        ? '<button type="button" data-fb-clear-all title="Remove all notes on this page">Clear all</button>'
        : "") +
      '<button type="button" data-fb-reload>Reload server</button>' +
      '<button type="button" data-fb-export>Export JSON</button>' +
      '<button type="button" data-fb-copy>Copy</button>' +
      '<button type="button" data-fb-close>✕</button>' +
      "</span></div>";
    var body = entries.length
      ? entries
          .map(function (e, i) {
            var done = e.status === "done";
            var needs = e.status === "needs_info";
            var statusClass = done
              ? "fb-status-done"
              : needs
                ? "fb-status-needs"
                : "fb-status-open";
            var statusLabel = done ? "✓ Done" : needs ? "? Needs reply" : "Open";
            return (
              '<div class="fb-item' +
              (done ? " fb-done" : "") +
              (needs ? " fb-needs" : "") +
              '">' +
              '<div class="fb-item-sel">' +
              '<span class="fb-status ' +
              statusClass +
              '">' +
              statusLabel +
              "</span>" +
              (e.scope === "global"
                ? '<span class="fb-scope">🌐 Page-wide</span>'
                : "") +
              " #" +
              (i + 1) +
              " · " +
              (e.scope === "global" ? "General feedback" : e.selector) +
              "</div>" +
              (i === editingIndex
                ? (function () {
                    var noteVal =
                      editingDraft && editingDraft.note !== undefined
                        ? editingDraft.note
                        : e.note || "";
                    var imgs =
                      editingDraft && editingDraft.images !== undefined
                        ? editingDraft.images
                        : imagesOf(e);
                    var docs =
                      editingDraft && editingDraft.files !== undefined
                        ? editingDraft.files
                        : filesOf(e);
                    return (
                      (needs && e.question
                        ? '<div class="fb-item-ask"><strong>Question from the team</strong>' +
                          String(e.question).replace(/</g, "&lt;") +
                          "</div>"
                        : "") +
                      '<textarea class="fb-edit-ta" placeholder="' +
                      (needs
                        ? "Reply here with more detail…"
                        : "Update your note…") +
                      '">' +
                      noteVal.replace(/</g, "&lt;") +
                      "</textarea>" +
                      imgs
                        .map(function (img, j) {
                          return (
                            '<div class="fb-preview" style="display:block">' +
                            '<img class="fb-item-img" src="' + resolveImg(img) +
                            '" alt="Attachment" style="margin:0" />' +
                            '<button type="button" class="fb-remove-img" data-fb-edit-rmimg="' +
                            j + '" title="Remove image">✕</button></div>'
                          );
                        })
                        .join("") +
                      docs
                        .map(function (f, j) {
                          return fileChipHtml(f, {
                            noLink: true,
                            rmAttr: 'data-fb-edit-rmfile="' + j + '"',
                          });
                        })
                        .join("") +
                      '<div class="fb-attach" style="margin:.35rem 0 0">' +
                      '<label class="fb-attach-btn">+ Add files' +
                      '<input type="file" accept="' +
                      FILE_ACCEPT +
                      '" multiple class="fb-edit-file" /></label>' +
                      '<p class="fb-attach-hint">Images, DOC, DOCX, PDF, TXT — multiple files OK (max 8 MB each)</p>' +
                      "</div>" +
                      '<div class="fb-row" style="margin:.4rem 0 .35rem">' +
                      '<button type="button" data-fb-edit-cancel>Cancel</button>' +
                      '<button type="button" data-fb-edit-save="' +
                      i +
                      '" style="background:#1d8843;border-color:#1d8843;color:#fff">' +
                      (needs ? "Send reply" : "Save") +
                      "</button>" +
                      "</div>"
                    );
                  })()
                : '<div class="fb-item-note">' +
                  (e.note || "").replace(/</g, "&lt;") +
                  "</div>" +
                  imagesOf(e)
                    .map(function (img) {
                      return (
                        '<img class="fb-item-img" src="' +
                        resolveImg(img) +
                        '" alt="Feedback attachment" data-fb-zoom />'
                      );
                    })
                    .join("") +
                  filesOf(e)
                    .map(function (f) {
                      return (
                        '<div class="fb-item-file">' +
                        fileChipHtml(f) +
                        "</div>"
                      );
                    })
                    .join("")) +
              (needs && e.question && i !== editingIndex
                ? '<div class="fb-item-ask"><strong>Question from the team</strong>' +
                  String(e.question).replace(/</g, "&lt;") +
                  "</div>"
                : "") +
              (done && e.resolution
                ? '<div class="fb-item-res">→ ' +
                  String(e.resolution).replace(/</g, "&lt;") +
                  "</div>"
                : "") +
              '<div class="fb-item-meta"><span>' +
              (e.date || new Date(e.ts).toLocaleString()) +
              (e.theme ? " · theme: " + String(e.theme).replace(/</g, "&lt;") : "") +
              "</span><span class=\"fb-item-actions\">" +
              (done
                ? '<button type="button" class="fb-del" data-fb-reopen="' +
                  i +
                  '">Reopen</button>'
                : needs
                  ? '<button type="button" class="fb-reply" data-fb-reply="' +
                    i +
                    '">Reply</button>'
                  : '<button type="button" class="fb-edit" data-fb-edit="' +
                    i +
                    '">Edit</button>') +
              '<button type="button" class="fb-del" data-fb-delete="' +
              i +
              '">Delete</button>' +
              "</span></div>" +
              "</div>"
            );
          })
          .join("")
      : ALLOW_NEW_FEEDBACK
        ? '<div class="fb-empty">No feedback yet. Turn on Feedback mode and click any element.</div>'
        : '<div class="fb-empty">No feedback on this page. Adding new notes is paused.</div>';
    panel.innerHTML = head + body;
  }

  panel.addEventListener("click", function (e) {
    var t = e.target;
    if (t.hasAttribute("data-fb-sync")) {
      submitFinal();
      renderPanel();
    }
    if (t.hasAttribute("data-fb-reload")) {
      /* Force discard empty/stuck dirty and reload server list */
      try {
        localStorage.removeItem(DIRTY_KEY);
        clearDeletedQueue();
      } catch (err) {}
      pullFromServer(function () {
        renderBadge();
        renderMarkers();
        renderSaveButton();
        renderPanel();
        showToast("Loaded " + load().length + " note(s) from server.", "ok");
      });
    }
    if (t.hasAttribute("data-fb-zoom")) {
      var w = window.open("", "_blank");
      w.document.write('<img src="' + t.src + '" style="max-width:100%">');
    }
    if (t.hasAttribute("data-fb-close")) closePanel();
    if (t.hasAttribute("data-fb-delete")) {
      var delIdx = Number(t.getAttribute("data-fb-delete"));
      var delAll = load();
      var delItem = delAll[delIdx];
      if (!delItem) return;
      var preview = (delItem.note || delItem.selector || "this note").slice(0, 80);
      if (
        !window.confirm(
          "Delete this feedback note?\n\n“" +
            preview +
            "”\n\nClick Save feedback afterward to remove it from the server."
        )
      ) {
        return;
      }
      if (editingIndex === delIdx) stopEdit();
      else if (editingIndex > delIdx) editingIndex -= 1;
      queueDeleteId(delItem.id);
      delAll.splice(delIdx, 1);
      save(delAll);
      renderBadge();
      renderMarkers();
      renderSaveButton();
      renderPanel();
      showToast("Note deleted locally — click Save feedback to sync.", "ok");
    }
    if (t.hasAttribute("data-fb-clear-all")) {
      var clearList = load();
      if (!clearList.length) return;
      if (
        !window.confirm(
          "Delete ALL " +
            clearList.length +
            " feedback note(s) on this page?\n\nClick Save feedback afterward to remove them from the server."
        )
      ) {
        return;
      }
      stopEdit();
      clearList.forEach(function (row) {
        if (row && row.id) queueDeleteId(row.id);
      });
      save([]);
      renderBadge();
      renderMarkers();
      renderSaveButton();
      renderPanel();
      showToast("All notes cleared locally — click Save feedback to sync.", "ok");
    }
    if (t.hasAttribute("data-fb-edit") || t.hasAttribute("data-fb-reply")) {
      startEdit(
        Number(
          t.getAttribute("data-fb-edit") || t.getAttribute("data-fb-reply")
        )
      );
      renderPanel();
      var ta = panel.querySelector(".fb-edit-ta");
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
    if (t.hasAttribute("data-fb-edit-rmimg")) {
      captureDraftNote();
      ensureDraftImages();
      if (editingDraft) {
        editingDraft.images.splice(Number(t.getAttribute("data-fb-edit-rmimg")), 1);
      }
      renderPanel();
    }
    if (t.hasAttribute("data-fb-edit-rmfile")) {
      captureDraftNote();
      ensureDraftFiles();
      if (editingDraft) {
        editingDraft.files.splice(Number(t.getAttribute("data-fb-edit-rmfile")), 1);
      }
      renderPanel();
    }
    if (t.hasAttribute("data-fb-edit-cancel")) {
      stopEdit();
      renderPanel();
    }
    if (t.hasAttribute("data-fb-edit-save")) {
      var idx = Number(t.getAttribute("data-fb-edit-save"));
      var ta2 = panel.querySelector(".fb-edit-ta");
      var all = load();
      if (all[idx]) {
        var v = ta2 ? ta2.value.trim() : "";
        var imgsChanged = editingDraft && editingDraft.images !== undefined;
        var filesChanged = editingDraft && editingDraft.files !== undefined;
        var finalImgs = imgsChanged ? editingDraft.images : imagesOf(all[idx]);
        var finalFiles = filesChanged ? editingDraft.files : filesOf(all[idx]);
        if (v || finalImgs.length || finalFiles.length) {
          all[idx].note = v;
          if (imgsChanged) {
            delete all[idx].image; // legacy single-image field
            if (editingDraft.images.length) {
              all[idx].images = editingDraft.images.slice();
            } else {
              delete all[idx].images;
            }
          }
          if (filesChanged) {
            if (editingDraft.files.length) {
              all[idx].files = editingDraft.files.map(function (f) {
                return Object.assign({}, f);
              });
            } else {
              delete all[idx].files;
            }
          }
          all[idx].editedAt = Date.now();
          /* Client reply to a clarification request → back to open for the team */
          if (all[idx].status === "needs_info") {
            all[idx].status = "open";
            all[idx].repliedAt = Date.now();
          }
          save(all);
        }
      }
      stopEdit();
      renderPanel();
    }
    if (t.hasAttribute("data-fb-reopen")) {
      var list = load();
      var reopenIdx = Number(t.getAttribute("data-fb-reopen"));
      var item = list[reopenIdx];
      if (item) {
        /* reopenedAt is required — server merge rejects done→open without it */
        item.status = "open";
        item.reopenedAt = Date.now();
        delete item.resolution;
        delete item.resolvedAt;
        save(list);
        startEdit(reopenIdx);
        renderPanel();
        var reopenTa = panel.querySelector(".fb-edit-ta");
        if (reopenTa) {
          reopenTa.focus();
          reopenTa.setSelectionRange(reopenTa.value.length, reopenTa.value.length);
        }
        showToast("Reopened — add what’s still wrong, then Save feedback.", "ok");
      }
    }
    if (t.hasAttribute("data-fb-export")) {
      var blob = new Blob([JSON.stringify(load(), null, 2)], {
        type: "application/json",
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "feedback.json";
      a.click();
      URL.revokeObjectURL(a.href);
    }
    if (t.hasAttribute("data-fb-copy")) {
      navigator.clipboard.writeText(JSON.stringify(load(), null, 2)).then(function () {
        t.textContent = "Copied!";
        setTimeout(function () {
          t.textContent = "Copy";
        }, 1200);
      });
    }
  });

  /* Append an attachment to the entry being edited (draft only until Save) */
  function addDraftAttachment(att) {
    if (!att || !editingDraft) return;
    if (att.kind === "file") {
      if (draftAttachCount() >= MAX_ATTACH_COUNT) {
        showToast("Max " + MAX_ATTACH_COUNT + " attachments per note.", "err");
        return;
      }
      ensureDraftFiles().push({
        name: att.name,
        data: att.data,
      });
      renderPanel();
      return;
    }
    if (att.kind === "image" && att.data) {
      if (draftAttachCount() >= MAX_ATTACH_COUNT) {
        showToast("Max " + MAX_ATTACH_COUNT + " attachments per note.", "err");
        return;
      }
      ensureDraftImages().push(att.data);
      renderPanel();
    }
  }

  /* Attach more files while editing an entry in the panel */
  panel.addEventListener("change", function (e) {
    var input = e.target;
    if (!input.classList || !input.classList.contains("fb-edit-file")) return;
    if (!input.files || !input.files.length) return;
    captureDraftNote();
    Array.prototype.forEach.call(input.files, function (file) {
      fileToDataUrl(file, addDraftAttachment);
    });
    input.value = "";
  });

  /* Pasting images into the edit textarea also works */
  panel.addEventListener("paste", function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains("fb-edit-ta")) return;
    var items = (ev.clipboardData || {}).items || [];
    var found = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") === 0) {
        found = true;
        fileToDataUrl(items[i].getAsFile(), addDraftAttachment);
      }
    }
    if (found) {
      ev.preventDefault();
      captureDraftNote();
    }
  });

  /* ---------- feedback mode ---------- */
  function setMode(on) {
    if (!ALLOW_NEW_FEEDBACK) on = false;
    mode = on;
    document.body.classList.toggle("fb-mode", on);
    renderBadge();
    if (!on) {
      removeHover();
      removeForm();
    }
  }

  toggle.addEventListener("click", function (e) {
    e.stopPropagation();
    if (!ALLOW_NEW_FEEDBACK) {
      if (panel.classList.contains("fb-open")) closePanel();
      else openPanel();
      return;
    }
    if (!mode && load().length && !panel.classList.contains("fb-open")) {
      openPanel();
    }
    setMode(!mode);
  });

  function removeHover() {
    if (hoverBox) {
      hoverBox.remove();
      hoverBox = null;
    }
  }

  function isUi(el) {
    return el.closest("[data-fb-ui]") !== null;
  }

  document.addEventListener(
    "mousemove",
    function (e) {
      if (!mode) return;
      var el = e.target;
      if (isUi(el) || el === document.body || el === document.documentElement) {
        removeHover();
        return;
      }
      if (!hoverBox) {
        hoverBox = document.createElement("div");
        hoverBox.className = "fb-hover-box";
        hoverBox.setAttribute("data-fb-ui", "");
        document.body.appendChild(hoverBox);
      }
      var r = el.getBoundingClientRect();
      hoverBox.style.left = window.scrollX + r.left - 2 + "px";
      hoverBox.style.top = window.scrollY + r.top - 2 + "px";
      hoverBox.style.width = r.width + "px";
      hoverBox.style.height = r.height + "px";
    },
    true
  );

  function removeForm() {
    if (formEl) {
      formEl.remove();
      formEl = null;
    }
    document.querySelectorAll(".fb-selected-box").forEach(function (b) {
      b.remove();
    });
  }

  /* Shared form for element feedback and page-wide (global) feedback */
  function openForm(opts) {
    if (!ALLOW_NEW_FEEDBACK) {
      if (!LOGGED_IN && LOGIN_URL) {
        location.href = LOGIN_URL;
        return;
      }
      showToast("Adding new notes is paused on this site.", "err");
      return;
    }
    removeForm();
    removeHover();

    var isGlobal = !!opts.global;
    var el = opts.el || null;
    var selector = isGlobal ? "(global)" : cssPath(el);

    if (el) {
      var r = el.getBoundingClientRect();
      var selBox = document.createElement("div");
      selBox.className = "fb-selected-box";
      selBox.setAttribute("data-fb-ui", "");
      selBox.style.left = window.scrollX + r.left - 2 + "px";
      selBox.style.top = window.scrollY + r.top - 2 + "px";
      selBox.style.width = r.width + "px";
      selBox.style.height = r.height + "px";
      document.body.appendChild(selBox);
    }

    formEl = document.createElement("div");
    formEl.className = "fb-form" + (isGlobal ? " fb-form-global" : "");
    formEl.setAttribute("data-fb-ui", "");
    formEl.innerHTML =
      '<p class="fb-sel">' +
      (isGlobal ? "🌐 General feedback for this page" : selector) +
      "</p>" +
      '<textarea placeholder="' +
      (isGlobal
        ? "Overall comments about this page (layout, colors, general feel…)"
        : "Comment on this element…") +
      '"></textarea>' +
      '<div class="fb-attach">' +
      '<label class="fb-attach-btn">+ Attach files<input type="file" accept="' +
      FILE_ACCEPT +
      '" multiple /></label>' +
      '<p class="fb-attach-hint">Images, DOC, DOCX, PDF, TXT — select multiple files</p>' +
      "</div>" +
      '<div class="fb-previews"></div>' +
      '<div class="fb-row"><button type="button" class="fb-cancel">Cancel</button><button type="button" class="fb-save">Save</button></div>';

    if (el) {
      var rect = el.getBoundingClientRect();
      var top = window.scrollY + rect.bottom + 8;
      var left = Math.min(
        window.scrollX + rect.left,
        window.scrollX + window.innerWidth - 340
      );
      formEl.style.top = top + "px";
      formEl.style.left = Math.max(8, left) + "px";
    }
    document.body.appendChild(formEl);
    var ta = formEl.querySelector("textarea");
    ta.focus();

    var attachedImages = [];
    var attachedFiles = [];
    var fileInput = formEl.querySelector('input[type="file"]');
    var previews = formEl.querySelector(".fb-previews");

    function renderPreviews() {
      previews.innerHTML =
        attachedImages
          .map(function (src, i) {
            return (
              '<div class="fb-preview" style="display:block">' +
              '<img alt="Preview" src="' +
              src +
              '" />' +
              '<button type="button" class="fb-remove-img" data-rm-img="' +
              i +
              '" title="Remove image">✕</button></div>'
            );
          })
          .join("") +
        attachedFiles
          .map(function (f, i) {
            return fileChipHtml(f, {
              noLink: true,
              rmAttr: 'data-rm-file="' + i + '"',
            });
          })
          .join("");
    }

    function addAttachment(att) {
      if (!att) return;
      if (attachedImages.length + attachedFiles.length >= MAX_ATTACH_COUNT) {
        showToast("Max " + MAX_ATTACH_COUNT + " attachments per note.", "err");
        return;
      }
      if (att.kind === "file") {
        attachedFiles.push({ name: att.name, data: att.data });
        renderPreviews();
        return;
      }
      if (att.kind === "image" && att.data) {
        attachedImages.push(att.data);
        renderPreviews();
      }
    }

    previews.addEventListener("click", function (ev) {
      var btnImg = ev.target.closest("[data-rm-img]");
      if (btnImg) {
        attachedImages.splice(Number(btnImg.getAttribute("data-rm-img")), 1);
        renderPreviews();
        return;
      }
      var btnFile = ev.target.closest("[data-rm-file]");
      if (btnFile) {
        attachedFiles.splice(Number(btnFile.getAttribute("data-rm-file")), 1);
        renderPreviews();
      }
    });

    fileInput.addEventListener("change", function () {
      Array.prototype.forEach.call(fileInput.files || [], function (file) {
        fileToDataUrl(file, addAttachment);
      });
      fileInput.value = "";
    });

    /* Pasting images into the textarea also works */
    ta.addEventListener("paste", function (ev) {
      var items = (ev.clipboardData || {}).items || [];
      var found = false;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") === 0) {
          found = true;
          fileToDataUrl(items[i].getAsFile(), addAttachment);
        }
      }
      if (found) ev.preventDefault();
    });

    formEl.querySelector(".fb-cancel").addEventListener("click", removeForm);
    formEl.querySelector(".fb-save").addEventListener("click", function () {
      var note = ta.value.trim();
      if (!note && !attachedImages.length && !attachedFiles.length) {
        ta.focus();
        return;
      }
      var entries = load();
      var now = Date.now();
      var theme =
        document.documentElement.getAttribute("data-theme") || "classic";
      var dateStr = new Date(now).toISOString().replace("T", " ").slice(0, 19) + " UTC";
      var entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        status: "open",
        scope: isGlobal ? "global" : "element",
        selector: selector,
        note: note,
        url: location.pathname + location.hash,
        page: document.title,
        text: el ? (el.textContent || "").trim().slice(0, 120) : "",
        snippet: el ? el.outerHTML.slice(0, 200) : "",
        ts: now,
        date: dateStr,
        theme: theme,
      };
      if (attachedImages.length) entry.images = attachedImages.slice();
      if (attachedFiles.length) {
        entry.files = attachedFiles.map(function (f) {
          return { name: f.name, data: f.data };
        });
      }
      entries.push(entry);
      try {
        save(entries);
      } catch (err) {
        alert("Storage is full — Export JSON first, or delete some notes.");
        return;
      }
      removeForm();
    });
  }


  document.addEventListener(
    "click",
    function (e) {
      if (!ALLOW_NEW_FEEDBACK || !mode) return;
      var el = e.target;
      if (isUi(el)) return;
      e.preventDefault();
      e.stopPropagation();
      openForm({ el: el });
    },
    true
  );

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      removeForm();
      if (mode) setMode(false);
      closePanel();
    }
  });

  renderBadge();
  renderSaveButton();
  pullFromServer(function () {
    renderBadge();
    renderMarkers();
    log("init done", { entries: load().length, dirty: isDirty() });
  });
  })();
/* cache-bust: 20260728-freeze-new */
