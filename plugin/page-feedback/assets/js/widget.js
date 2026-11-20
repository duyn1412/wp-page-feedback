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
  var CURRENT_IP = String(CFG.clientIp || "").trim();
  var IP_FILTER_KEY = "pfb-ip-filter:" + PAGE_SLUG;
  var activeIpFilter = localStorage.getItem(IP_FILTER_KEY) || (CURRENT_IP ? "my" : "all");

  function findEntryIndex(idOrIdx) {
    var all = load();
    if (idOrIdx === null || idOrIdx === undefined || idOrIdx === "") return -1;
    for (var i = 0; i < all.length; i++) {
      if (all[i] && String(all[i].id) === String(idOrIdx)) return i;
    }
    var num = Number(idOrIdx);
    if (!isNaN(num) && num >= 0 && num < all.length) return num;
    return -1;
  }

  function getFilteredEntries(all) {
    all = all || load();
    if (!CURRENT_IP || activeIpFilter === "all") {
      return all;
    }
    if (activeIpFilter === "my") {
      return all.filter(function (e) {
        return !e.ip || e.ip === CURRENT_IP;
      });
    }
    return all.filter(function (e) {
      return e.ip === activeIpFilter;
    });
  }

  function getAllIps(all) {
    var seen = {};
    var list = [];
    (all || load()).forEach(function (e) {
      var ip = (e && e.ip) ? String(e.ip).trim() : "";
      if (ip && !seen[ip]) {
        seen[ip] = true;
        list.push(ip);
      }
    });
    return list;
  }

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
    setPanelSaveStatus("Draft saved in this browser.");
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
    var savedNotes = localStorage.getItem(STORAGE_KEY);
    var savedDeletes = localStorage.getItem(DELETED_KEY);

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
        /* Validate by re-fetching the JSON file from disk/CDN */
        if (!FILE_URL) {
          return { res: res, verified: false };
        }
        var reReadHeaders = { Accept: "application/json" };
        if (REST_NONCE) reReadHeaders["X-WP-Nonce"] = REST_NONCE;
        return fetch(FILE_URL + (FILE_URL.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now(), {
          cache: "no-store",
          credentials: "same-origin",
          headers: reReadHeaders,
        })
          .then(function (r2) {
            if (!r2.ok) {
              log("re-read warning: status " + r2.status);
              return {
                res: res,
                verified: false,
                fileCount: (res.entries || []).length,
                file: res.file || ("feedback/" + PAGE_SLUG + ".json"),
              };
            }
            return r2.json().then(function (fileEntries) {
              if (!Array.isArray(fileEntries)) {
                return {
                  res: res,
                  verified: false,
                  fileCount: (res.entries || []).length,
                  file: res.file || ("feedback/" + PAGE_SLUG + ".json"),
                };
              }
              var missing = [];
              Object.keys(sentIds).forEach(function (id) {
                var found = fileEntries.some(function (e) {
                  return e && String(e.id) === id;
                });
                if (!found) missing.push(id);
              });
              if (missing.length) {
                log("re-read missing ids", missing);
              }
              return {
                res: res,
                verified: missing.length === 0,
                fileCount: fileEntries.length,
                file: res.file || ("feedback/" + PAGE_SLUG + ".json"),
              };
            });
          })
          .catch(function (reReadErr) {
            log("re-read error ignored", reReadErr);
            return {
              res: res,
              verified: false,
              fileCount: (res.entries || []).length,
              file: res.file || ("feedback/" + PAGE_SLUG + ".json"),
            };
          });
      })
      .then(function (info) {
        var newerDraft = localStorage.getItem(STORAGE_KEY) !== savedNotes ||
          localStorage.getItem(DELETED_KEY) !== savedDeletes;
        if (!newerDraft) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(info.res.entries));
          clearDeletedQueue();
          clearDirty();
        }
        log("sync ok", info.file || (info.res && info.res.file), (info.res.entries || []).length + " entries", "verified=" + !!info.verified);
        onDone &&
          onDone(true, {
            count: (info.res.entries || []).length,
            file: info.file || (info.res && info.res.file) || ("feedback/" + PAGE_SLUG + ".json"),
            verified: !!info.verified,
            newerDraft: newerDraft,
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

  function pullFromServer(cb) {
    if (!FILE_URL || location.protocol === "file:" || saving) {
      cb(false);
      return;
    }
    var generation = syncGeneration;

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
        if (serverEntries == null || generation !== syncGeneration) {
          cb(false);
          return;
        }
        var local = isDirty() ? load() : [];
        var hasDraft = local.length > 0 || loadDeleted().length > 0;
        var next = hasDraft ? mergeFeedbackLists(serverEntries, local) : serverEntries;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        if (!hasDraft) clearDirty();
        cb(true);
      })
      .catch(function (err) {
        log("pull failed", err);
        cb(false);
      });
  }


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
  css += ".fb-dock{position:fixed;bottom:18px;right:22px;z-index:10000;display:flex;align-items:center;gap:5px;padding:7px;background:#0a1931f2;color:#fff;border:1px solid #ffffff30;border-radius:16px;box-shadow:0 16px 35px #06172d5c;backdrop-filter:blur(14px);box-sizing:border-box;font:700 12px/1.25 Inter,system-ui,sans-serif;}";
  css += ".fb-dock .fb-tool{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;min-height:40px;padding:9px 13px;margin:0;border:0;border-radius:10px;background:transparent;color:#d9e5f6;font:inherit;white-space:nowrap;box-shadow:none;}";
  css += ".fb-dock button.fb-tool{cursor:pointer;}.fb-dock button.fb-tool:disabled{opacity:.48;cursor:default;}";
  css += ".fb-dock button.fb-tool:hover:not(:disabled),.fb-dock .fb-toggle,.fb-dock button[aria-pressed=true]{background:#ffffff22;color:#fff;}";
  css += ".fb-dock button:focus-visible{outline:2px solid #a7c7ff;outline-offset:1px;}";
  css += ".fb-tool-symbol{font-size:16px;line-height:1;}.fb-tool-divider{width:1px;height:24px;background:#ffffff35;}";
  css += ".fb-tool-dot{width:8px;height:8px;border-radius:50%;background:#0ccc88;}.fb-tool-dot.fb-off{background:#9cacc2;}";
  css += "@media(max-width:560px){.fb-dock{bottom:9px;right:8px;max-width:calc(100vw - 16px);}.fb-dock .fb-tool{padding:9px 8px;gap:3px;font-size:11px;}.fb-dock .fb-tool-new{display:none;}}";
  css += ".fb-inspect-tool{position:relative;--fb-inspect-primary:#dc2626;--fb-inspect-primary-dark:#b91c1c;--fb-inspect-light:#f1f5f9;--fb-inspect-white:#fff;}.fb-dock button[data-fb-inspect]{position:relative;display:grid;place-items:center;flex:none;width:40px;height:40px;min-width:40px;min-height:40px;padding:0;border:1px solid var(--fb-inspect-light);border-radius:50%;background:var(--fb-inspect-primary);color:var(--fb-inspect-white);}";
  css += ".fb-dock button[data-fb-inspect] .fb-inspect-icon{display:block;width:20px;height:20px;margin:0;padding:0;flex:none;}.fb-dock button[data-fb-inspect]:hover:not(:disabled),.fb-dock button[data-fb-inspect][aria-pressed=true]{background:var(--fb-inspect-primary-dark);color:var(--fb-inspect-white);border-color:var(--fb-inspect-light);}";
  css += ".fb-inspect-guide{position:absolute;pointer-events:none;right:-135px;bottom:calc(100% + 12px);width:min(220px,calc(100vw - 24px));box-sizing:border-box;padding:10px 12px;background:#fff;color:#334155;border:1px solid #dbe7fc;border-radius:12px;box-shadow:0 8px 28px #10294d28;font:400 12px/1.45 system-ui,sans-serif;}";
  css += ".fb-inspect-guide[hidden]{display:none;}";
  css += ".fb-inspect-guide::after{content:'';position:absolute;top:100%;right:155px;transform:translateX(50%);border:6px solid transparent;border-top-color:#fff;}";
  css += "@keyframes fbInspectRipple{0%{transform:scale(1);opacity:.85;}68%,100%{transform:scale(1.6);opacity:0;}}";
  css += "@media(prefers-reduced-motion:no-preference){.fb-dock button[data-fb-inspect][aria-pressed=false]:not(:disabled)::after{content:'';position:absolute;inset:-2px;border:2px solid var(--fb-inspect-primary);border-radius:inherit;pointer-events:none;animation:fbInspectRipple 1.9s ease-out infinite;}}";
  css += ".fb-unsaved-banner{position:fixed;bottom:4.6rem;right:1rem;z-index:10002;max-width:min(440px,92vw);background:#0f172a;color:#f8fafc;border:1px solid #f59e0b;border-radius:12px;padding:.85rem 1.1rem;box-shadow:0 16px 40px rgba(0,0,0,.45);display:flex;align-items:center;gap:12px;font:500 12.5px/1.45 system-ui,-apple-system,sans-serif;animation:fbSlideDown .25s ease-out;}";
  css += ".fb-unsaved-icon{font-size:22px;flex-shrink:0;}";
  css += ".fb-unsaved-body{flex:1;}";
  css += ".fb-unsaved-body strong{color:#fbbf24;display:block;font-weight:700;margin-bottom:2px;}";
  css += ".fb-unsaved-btn{display:inline-flex;align-items:center;padding:.45rem .85rem;border-radius:8px;background:#f59e0b;color:#0f172a!important;font:700 12px/1 system-ui,sans-serif;text-decoration:none!important;white-space:nowrap;flex-shrink:0;transition:background .2s ease;}";
  css += ".fb-unsaved-btn:hover{background:#d97706;}";
  css += ".fb-unsaved-close{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;background:rgba(255,255,255,.1);color:#94a3b8;border-radius:50%;font-size:11px;cursor:pointer;flex-shrink:0;}";
  css += ".fb-unsaved-close:hover{color:#fff;background:rgba(255,255,255,.2);}";
  css += "@keyframes fbSlideDown{from{opacity:0;transform:translate(-50%,-12px)}to{opacity:1;transform:translate(-50%,0)}}";
  css += ".fb-savebtn{display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1rem;border:0;border-radius:999px;background:#9aa4b2;color:#fff;font:600 13px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.2);}";
  css += ".fb-savebtn.fb-dirty{background:#1d8843;}";
  css += ".fb-savebtn.fb-ok{background:#1d8843;}";
  css += ".fb-savebtn.fb-err{background:#e04545;}";
  css += ".fb-savebtn.fb-login-btn{background:#2563eb;color:#fff;}";
  css += ".fb-savebtn.fb-login-btn:hover{background:#1d4ed8;}";
  css += ".fb-savebtn:disabled{opacity:.85;cursor:default;}";
  css += ".fb-toast{position:fixed;left:50%;bottom:5.5rem;transform:translateX(-50%);z-index:10001;max-width:min(420px,92vw);padding:.75rem 1.1rem;border-radius:12px;font:600 13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 12px 32px rgba(0,0,0,.28);pointer-events:none;opacity:0;transition:opacity .2s ease;}";
  css += ".fb-toast.fb-show{opacity:1;}";
  css += ".fb-toast.fb-ok{background:#1d8843;}";
  css += ".fb-toast.fb-err{background:#e04545;}";
  css += ".fb-form.fb-form-global{width:400px;}";
  css += ".fb-form,.fb-panel{--pfb-accent:#dc2626;--pfb-accent-hover:#b91c1c;--pfb-surface:#fff;--pfb-soft:#f4f4f5;--pfb-ink:#18181b;--pfb-muted:#52525b;--pfb-line:#e4e4e7;--pfb-hover:#ececef;--pfb-control-radius:6px;--pfb-control-size:28px;}";
  css += "body.fb-mode{touch-action:manipulation;}body.fb-mode,body.fb-mode *{cursor:crosshair!important;}body.fb-mode [data-fb-ui],body.fb-mode [data-fb-ui] *{cursor:auto!important;}";
  css += "[data-fb-ui] :is(button:not(:disabled),a[href],summary,label:has(input),select,input[type=checkbox]),button[data-fb-ui]:not(:disabled),body.fb-mode [data-fb-ui] :is(button:not(:disabled),a[href],summary,label:has(input),select,input[type=checkbox]),body.fb-mode button[data-fb-ui]:not(:disabled),body.fb-mode .fb-panel :is(fig-button,fig-menu-item){cursor:pointer!important;}";
  css += "body.fb-mode [data-fb-ui] :is(button,a,summary,label) :not(input){cursor:inherit!important;}[data-fb-ui] :is(textarea,input[type=search],input[type=text]){cursor:text!important;}body.fb-mode [data-fb-ui] :is(textarea,input[type=search],input[type=text]){cursor:text!important;}";
  css += ".fb-hover-box{position:absolute;z-index:9997;pointer-events:none;border:2px dashed #e04545;background:rgba(224,69,69,.08);border-radius:4px;}";
  css += ".fb-selected-box{position:absolute;z-index:9997;pointer-events:none;border:2px solid #e04545;background:rgba(224,69,69,.12);border-radius:4px;}";
  css += ".fb-form{position:fixed;z-index:9999;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px;width:320px;background:#fff;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 10px 28px #0f172a33;padding:4px;font:400 13px/1.45 system-ui,sans-serif;color:#121826;}";
  css += ".fb-form:focus-within{border-color:#dc2626;box-shadow:0 0 0 2px #dc262618,0 10px 28px #0f172a33;}";
  css += ".fb-form.fb-compose-expanded{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;gap:0;}";
  css += ".fb-form-content{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;}";
  css += ".fb-form[data-fb-ui] textarea{display:block;width:100%;height:36px;min-height:0;max-height:120px;box-sizing:border-box;margin:0;padding:8px;border:0;outline:none;background:#fff;color:#111827;font:400 14px/1.4 system-ui,sans-serif;resize:none;}";
  css += ".fb-form.fb-compose-expanded textarea{height:62px;min-height:62px;}";
  css += ".fb-form-attachments{min-width:0;}.fb-form-attachments[hidden]{display:none;}.fb-form .fb-previews:not(:empty){padding:0 8px 6px;}";
  css += ".fb-form-attachments .fb-attach-row{gap:3px;flex-wrap:nowrap;}.fb-form .fb-form-attachments .fb-capture-btn,.fb-form .fb-form-attachments .fb-attach-btn{appearance:none;box-sizing:border-box;display:grid;place-items:center;width:32px;height:32px;min-width:0;min-height:0;margin:0;padding:0;border:0;border-radius:8px;background:var(--pfb-surface);color:var(--pfb-muted);box-shadow:none;}";
  css += ".fb-form .fb-form-attachments .fb-capture-btn:hover:not(:disabled),.fb-form .fb-form-attachments .fb-attach-btn:hover{background:var(--pfb-soft);color:var(--pfb-ink);}.fb-form-attachments .fb-attach-btn,.fb-form-attachments .fb-auto-cap-lbl{position:relative;}.fb-form-attachments .fb-attach-btn input[type=file],.fb-form-attachments .fb-auto-cap-lbl input{display:block;position:absolute;width:1px;height:1px;opacity:0;padding:0;}";
  css += ".fb-form-attachments .fb-auto-cap-lbl{min-height:32px;margin:0;padding:0 5px;gap:5px;border-radius:8px;color:var(--pfb-muted);font:600 12px/1.3 system-ui,sans-serif;white-space:nowrap;}.fb-form-attachments .fb-auto-cap-lbl:hover{background:var(--pfb-soft);}.fb-auto-switch{position:relative;width:24px;height:14px;border:1px solid #94a3b8;border-radius:12px;background:#e2e8f0;}.fb-auto-switch::after{content:'';position:absolute;left:2px;top:2px;width:8px;height:8px;border-radius:50%;background:#475569;}.fb-auto-cap-cb:checked+.fb-auto-switch{background:var(--pfb-accent);border-color:var(--pfb-accent);}.fb-auto-cap-cb:checked+.fb-auto-switch::after{left:12px;background:#fff;}";
  css += ".fb-form-attachments :is(.fb-attach-btn,.fb-auto-cap-lbl):focus-within,.fb-form-attachments button:focus-visible{outline:2px solid var(--pfb-accent);outline-offset:-2px;}";
  css += ".fb-form .fb-row{display:flex;align-items:center;justify-content:flex-end;gap:3px;}";
  css += ".fb-form.fb-compose-expanded .fb-row{justify-content:space-between;padding:4px 2px 0;border-top:1px solid #e2e8f0;}.fb-form .fb-compose-actions{display:flex;align-items:center;gap:3px;margin-left:auto;}.fb-form .fb-row>.fb-compose-attach,.fb-form .fb-compose-actions{flex:none;}";
  css += ".fb-form button{padding:.42rem .85rem;border-radius:8px;border:1px solid #d5dce8;background:#fff;font:600 12px system-ui,sans-serif;cursor:pointer;}";
  css += ".fb-form[data-fb-ui] .fb-row>button,.fb-form[data-fb-ui] .fb-compose-actions>button{appearance:none;box-sizing:border-box;display:grid;place-items:center;width:32px;height:32px;min-width:0;min-height:0;margin:0;padding:0;border:0;border-radius:8px;background:#fff;color:#475569;box-shadow:none;}";
  css += ".fb-form[data-fb-ui] .fb-row button:hover,.fb-form[data-fb-ui] .fb-row button[aria-expanded=true]{background:#f1f5f9;color:#111827;}.fb-form[data-fb-ui] .fb-row svg{display:block;width:17px;height:17px;}";
  css += ".fb-form[data-fb-ui] .fb-row button.fb-save{background:#dc2626;color:#fff;border-radius:50%;}.fb-form[data-fb-ui] .fb-row button.fb-save:hover{background:#b91c1c;}.fb-form[data-fb-ui] .fb-row button.fb-save:disabled{background:#f1f5f9;color:#64748b;cursor:default;}";
  css += ".fb-form[data-fb-ui] .fb-row button:focus-visible,button.fb-marker[data-fb-ui]:focus-visible{outline:2px solid #dc2626;outline-offset:2px;}";
  css += "button.fb-marker[data-fb-ui]{appearance:none;box-sizing:border-box;position:fixed;z-index:9998;display:grid;place-items:center;width:28px;height:28px;min-width:0;min-height:0;max-width:none;max-height:none;margin:0;padding:0;border-radius:50%;--fb-marker-color:#c52e3d;background:var(--fb-marker-color);color:#fff;border:2px solid #fff;box-shadow:0 3px 10px #0f172a4d;font:700 12px/1 system-ui,sans-serif;text-align:center;letter-spacing:normal;text-transform:none;user-select:none;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease;}";
  css += "button.fb-marker[data-fb-ui]:hover{transform:scale(1.12);background:var(--fb-marker-color);color:#fff;box-shadow:0 4px 14px #0f172a66;}";
  css += "button.fb-marker.fb-marker-needs[data-fb-ui]{--fb-marker-color:#8a5700;} button.fb-marker.fb-marker-done[data-fb-ui]{--fb-marker-color:#167342;}";
  css += "@keyframes fbMarkerPulse{0%{transform:scale(1);opacity:.28;}70%,100%{transform:scale(1.18);opacity:0;}}";
  css += "@media(prefers-reduced-motion:no-preference){.fb-marker::after{content:'';position:absolute;inset:-1px;border:1px solid var(--fb-marker-color);border-radius:inherit;pointer-events:none;opacity:0;animation:fbMarkerPulse 1.5s ease-out 2;}}";
  css += ".fb-panel{position:fixed;right:22px;bottom:86px;max-height:min(520px,70vh);max-height:min(520px,70dvh);z-index:9999;width:min(465px,calc(100vw - 28px));overflow:hidden;background:#fff;border:1px solid var(--pfb-line);border-radius:12px;box-shadow:0 12px 32px #0f172a33;font:400 14px/1.45 Inter,system-ui,sans-serif;color:var(--pfb-ink);display:none;}";
  css += ".fb-panel.fb-open{display:flex;flex-direction:column;}";
  css += ".fb-panel *, .fb-panel{box-sizing:border-box;}";
  css += ".fb-panel-head,.fb-panel-foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 16px;}";
  css += ".fb-panel-head{padding-block:10px;border-bottom:0;}";
  css += ".fb-panel-heading,.fb-panel-head .fb-actions{display:flex;align-items:center;gap:8px;}";
  css += ".fb-panel-heading strong{font-size:17px;letter-spacing:-.02em;}";
  css += ".fb-panel-count{padding:0 6px;background:var(--pfb-soft);border-radius:5px;color:var(--pfb-muted);font-weight:650;}";
  css += ".fb-panel button.fb-panel-icon{border:0;background:transparent;color:#576982;border-radius:10px;width:var(--pfb-control-size);height:var(--pfb-control-size);padding:0;font:600 18px/1 system-ui;cursor:pointer;}";
  css += ".fb-panel button.fb-panel-icon:hover,.fb-panel-options summary:hover{background:var(--pfb-hover);color:var(--pfb-ink);}";
  css += ".fb-panel button.fb-add{display:grid;place-items:center;width:30px;height:30px;min-width:0;min-height:0;padding:0;border:0;border-radius:8px;background:var(--pfb-accent);color:#fff;font:700 14px/1.4 system-ui;cursor:pointer;}";
  css += ".fb-panel button.fb-add:hover{background:var(--pfb-accent-hover);}.fb-panel button.fb-add svg{width:17px;height:17px;}";
  css += ".fb-panel-foot{color:#475569;font-size:14px;overflow-wrap:anywhere;}.fb-panel-save-status{min-width:0;}.fb-panel-save-status[data-kind=success]{color:#166534;}.fb-panel-save-status[data-kind=error]{color:#b91c1c;}";
  css += ".fb-panel-segment{flex:none;display:flex;gap:14px;margin:0 16px 8px;border-bottom:1px solid var(--pfb-line);}";
  css += ".fb-panel .fb-panel-segment button{flex:none;min-height:34px;padding:4px 2px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--pfb-muted);font:600 14px/1.4 system-ui;box-shadow:none;text-transform:none;}.fb-panel .fb-panel-segment button:hover{color:var(--pfb-ink);}";
  css += ".fb-panel .fb-panel-segment button[aria-pressed=true]{border-bottom-color:var(--pfb-accent);color:var(--pfb-ink);}";
  css += ".fb-panel-filters{flex:none;display:flex;gap:6px;padding:0 16px 10px;border-bottom:1px solid var(--pfb-line);}";
  css += ".fb-panel-filters select,.fb-panel-filters input{min-width:0;margin:0;height:32px;padding:4px 8px;border:1px solid var(--pfb-line);border-radius:var(--pfb-control-radius);background:var(--pfb-soft);color:var(--pfb-muted);font:400 14px system-ui;}";
  css += ".fb-panel-filters select{width:auto;max-width:43%;}.fb-panel-filters input{flex:1;}";
  css += ".fb-panel :is(.fb-item-actions button,.fb-image-button,.fb-item-context,.fb-edit-actions button)[aria-label]{position:relative;}";
  css += ".fb-panel :is(.fb-item-actions button,.fb-image-button,.fb-item-context,.fb-edit-actions button)[aria-label]:is(:focus-visible,:hover:not([title]))::after{content:attr(aria-label);position:absolute;top:calc(100% + 4px);right:0;z-index:2;pointer-events:none;background:#27272a;color:#fff;padding:4px 7px;border-radius:5px;font:500 14px/1.3 system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 6px #18181b33;}";
  css += ".fb-panel :focus-visible{outline:2px solid var(--pfb-accent);outline-offset:2px;}";
  css += ".fb-panel-list{flex:0 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#c4c4ca transparent;padding:2px 16px 6px;}";
  css += ".fb-panel-foot{border-top:1px solid var(--pfb-line);padding-block:8px;}";
  css += ".fb-panel-options{position:relative;}.fb-panel-options summary{list-style:none;display:grid;place-items:center;cursor:pointer;width:28px;height:28px;border-radius:var(--pfb-control-radius);color:var(--pfb-muted);font-size:18px;}.fb-panel-options summary::-webkit-details-marker{display:none;}";
  css += ".fb-panel-menu{position:absolute;z-index:1;top:100%;right:0;min-width:160px;padding:6px;border:1px solid #e4e9f2;border-radius:10px;background:#fff;box-shadow:0 8px 20px #10294d20;}";
  css += ".fb-panel-menu button,.fb-panel-foot button{border:0;background:transparent;color:#334155;padding:6px;font:700 14px/1.4 system-ui;cursor:pointer;white-space:nowrap;}";
  css += ".fb-panel-menu button:disabled{opacity:.55;cursor:default;}.fb-panel-menu button{box-shadow:none;display:block;width:100%;text-align:left;}.fb-panel-menu button:hover{background:var(--pfb-soft);}.fb-panel-menu button[data-fb-clear-all]{color:#b91c1c;}";
  css += ".fb-item{padding:10px 2px;border-bottom:1px solid var(--pfb-line);background:var(--pfb-surface);}.fb-item:last-child{border-bottom:0;}";
  css += ".fb-item-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:8px;}.fb-item-main{min-width:0;}.fb-item.fb-item-editing .fb-item-top{grid-template-columns:auto minmax(0,1fr);}";
  css += ".fb-item-heading{display:flex;align-items:center;flex-wrap:wrap;gap:2px 6px;min-height:26px;}.fb-item-heading .fb-item-date{margin-right:auto;}.fb-panel button.fb-image-button,.fb-panel button.fb-item-context{display:inline-flex;align-items:center;gap:4px;min-height:var(--pfb-control-size);margin:0;padding:2px 5px;border:0;border-radius:var(--pfb-control-radius);background:transparent;color:var(--pfb-muted);font:700 14px system-ui;box-shadow:none;cursor:pointer;}.fb-panel :is(.fb-image-button,.fb-item-context):hover{background:var(--pfb-hover);color:var(--pfb-ink);}.fb-image-button svg,.fb-item-context svg{width:14px;height:14px;}.fb-panel button.fb-item-context{width:var(--pfb-control-size);padding:0;justify-content:center;}";
  css += "dialog.fb-image-dialog{box-sizing:border-box;width:min(720px,calc(100vw - 24px));max-height:calc(100dvh - 24px);margin:auto;padding:10px;border:1px solid #dbe3ed;border-radius:12px;background:#fff;color:#1e293b;font:600 14px system-ui;overflow:auto;}dialog.fb-image-dialog::backdrop{background:#0f172ad9;}";
  css += ".fb-image-dialog-head,.fb-image-dialog-controls{display:flex;align-items:center;justify-content:space-between;gap:6px;}.fb-image-dialog-controls[hidden]{display:none;}.fb-image-dialog img{display:block;width:100%;max-height:min(72vh,620px);max-height:min(72dvh,620px);margin:8px 0;object-fit:contain;background:#f1f5f9;border-radius:8px;}";
  css += "dialog.fb-image-dialog button{padding:4px 8px;min-height:28px;border:1px solid #dbe3ed;border-radius:7px;background:#fff;color:#334155;font:700 14px system-ui;box-shadow:none;cursor:pointer;}dialog.fb-image-dialog button:disabled{opacity:.45;}dialog.fb-image-dialog button[data-image-remove]{color:#b91c1c;}";
  css += ".fb-item-number,.fb-item-date,.fb-item-scope{color:var(--pfb-muted);font-size:14px;}.fb-item-number{display:grid;place-items:center;min-width:30px;height:30px;padding:0 4px;background:var(--pfb-soft);border-radius:7px;font-variant-numeric:tabular-nums;}.fb-item-date{white-space:nowrap;font-variant-numeric:tabular-nums;}.fb-item-scope{white-space:nowrap;}";
  css += ".fb-item .fb-item-note{margin:1px 0 2px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;color:var(--pfb-ink);}";
  css += ".fb-item-actions{flex:none;display:flex;gap:3px;}.fb-panel .fb-item-actions button{display:grid;place-items:center;width:var(--pfb-control-size);height:var(--pfb-control-size);margin:0;padding:0;border:0;border-radius:var(--pfb-control-radius);background:transparent;color:var(--pfb-muted);box-shadow:none;cursor:pointer;}.fb-panel .fb-item-actions button:hover{background:var(--pfb-hover);color:var(--pfb-ink);}.fb-panel .fb-item-actions button[data-fb-delete]:hover{background:#fef2f2;color:#991b1b;}.fb-item-actions svg{width:16px;height:16px;}";
  css += ".fb-panel .fb-panel-foot .fb-savebtn{padding:6px 10px;border:1px solid #dbe3ed;border-radius:8px;background:#f8fafc;color:#334155;box-shadow:none;}.fb-panel .fb-panel-foot .fb-savebtn:hover:not(:disabled){background:var(--pfb-hover);color:var(--pfb-ink);}.fb-panel .fb-panel-foot .fb-savebtn.fb-dirty:not(.fb-login-btn){background:var(--pfb-accent);border-color:var(--pfb-accent);color:#fff;}.fb-panel .fb-panel-foot .fb-savebtn.fb-dirty:not(.fb-login-btn):hover{background:var(--pfb-accent-hover);border-color:var(--pfb-accent-hover);color:#fff;}.fb-panel .fb-panel-foot .fb-savebtn:disabled{opacity:.55;cursor:default;}";
  css += ".fb-located-target{outline:3px solid #2563eb!important;outline-offset:4px!important;}";
  css += "@media(max-width:560px){.fb-panel{right:8px;bottom:76px;width:min(465px,calc(100vw - 16px));}.fb-panel-head,.fb-panel-filters,.fb-panel-list,.fb-panel-foot{padding-inline:12px;}.fb-panel-segment{margin-inline:12px;}}";
  css += "@media(max-height:430px){.fb-panel{max-height:calc(100vh - 94px);max-height:calc(100dvh - 94px);overflow:auto;overscroll-behavior:contain;}.fb-panel-list{flex:none;overflow:visible;}}";
  css += "@media(max-width:420px){.fb-panel-head .fb-actions,.fb-panel-heading{gap:4px;}.fb-panel button.fb-panel-icon,.fb-panel-options summary{width:30px;}}";
  css += ".fb-item> :is(.fb-edit-composer,.fb-item-ask,.fb-item-res,.fb-item-file){margin-left:38px;}.fb-edit-composer{margin:5px 0 2px;border:1px solid var(--pfb-line);border-radius:8px;background:var(--pfb-surface);}.fb-edit-composer:focus-within{border-color:var(--pfb-accent);box-shadow:0 0 0 2px #dc262618;}";
  css += ".fb-item .fb-edit-toolbar{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:3px 5px;border-top:1px solid #e2e8f0;}.fb-edit-actions{display:flex;gap:3px;}.fb-panel .fb-edit-composer .fb-item-file,.fb-edit-composer>.fb-file-chip{margin:4px 8px;}";
  css += ".fb-panel .fb-edit-composer :is(.fb-attach-btn,button){position:relative;box-sizing:border-box;display:grid;place-items:center;width:var(--pfb-control-size);height:var(--pfb-control-size);margin:0;padding:0;border:0;border-radius:var(--pfb-control-radius);background:transparent;color:var(--pfb-muted);box-shadow:none;}.fb-panel .fb-edit-composer :is(.fb-attach-btn,button):hover{background:var(--pfb-hover);color:var(--pfb-ink);}.fb-edit-toolbar svg{width:17px;height:17px;}";
  css += ".fb-panel .fb-edit-composer button[data-fb-edit-save]{border-radius:50%;background:var(--pfb-accent);color:#fff;}.fb-panel .fb-edit-composer button[data-fb-edit-save]:hover{background:var(--pfb-accent-hover);color:#fff;}";
  css += ".fb-edit-toolbar .fb-edit-file{position:absolute;width:1px;height:1px;opacity:0;padding:0;}.fb-edit-toolbar .fb-attach-btn:focus-within{outline:2px solid var(--pfb-accent);}";
  css += ".fb-panel .fb-item .fb-edit-ta{display:block;box-sizing:border-box;width:100%;min-height:58px;margin:0;padding:8px 9px;border:0;border-radius:inherit;background:transparent;color:var(--pfb-ink);font:inherit;resize:vertical;}.fb-panel .fb-item .fb-edit-ta:focus{outline:none;}";
  css += ".fb-empty{padding:.65rem .55rem;color:#8a94a6;}";
  css += ".fb-attach{display:flex;flex-direction:column;gap:.4rem;margin-top:.55rem;}";
  css += ".fb-attach-row{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;}";
  css += ".fb-attach input[type=file]{display:none;}";
  css += ".fb-attach .fb-attach-btn{padding:.38rem .7rem;border-radius:8px;border:1px dashed #d5dce8;background:#f8fafc;font:600 11.5px system-ui,sans-serif;color:#5a6578;cursor:pointer;display:inline-flex;align-items:center;gap:4px;}";
  css += ".fb-attach .fb-attach-btn:hover{border-color:#e04545;color:#e04545;}";
  css += ".fb-capture-btn{padding:.38rem .7rem;border-radius:8px;border:1px solid #cbd5e1;background:#fff;font:600 11.5px system-ui,sans-serif;color:#1e293b;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:all .15s;}";
  css += ".fb-capture-btn:hover{border-color:#e04545;color:#e04545;background:#fff5f5;}";
  css += ".fb-capture-btn:disabled{opacity:.6;cursor:not-allowed;}";
  css += ".fb-auto-cap-lbl{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#64748b;cursor:pointer;margin-left:auto;user-select:none;}";
  css += ".fb-auto-cap-lbl input{margin:0;cursor:pointer;}";
  css += ".fb-attach-hint{font-size:10.5px;color:#8a94a6;width:100%;margin:0;}";
  css += ".fb-preview{position:relative;display:none;margin-top:.55rem;}";
  css += ".fb-preview img{display:block;max-width:100%;max-height:140px;border-radius:8px;border:1px solid #d5dce8;}";
  css += ".fb-preview .fb-remove-img{position:absolute;top:-7px;right:-7px;width:20px;height:20px;border-radius:999px;border:0;background:#0b1220;color:#fff;font:700 11px/20px system-ui,sans-serif;cursor:pointer;padding:0;}";
  css += ".fb-file-chip{position:relative;display:flex;align-items:center;gap:.45rem;margin-top:.45rem;padding:.45rem .55rem;border:1px solid #eef1f6;border-radius:8px;background:#f8fafc;font:600 12px/1.35 system-ui,sans-serif;color:#121826;text-decoration:none;}";
  css += ".fb-file-chip:hover{border-color:#c5d0e0;}";
  css += ".fb-file-chip .fb-file-icon{flex:0 0 auto;width:1.5rem;height:1.5rem;border-radius:5px;background:#003b95;color:#fff;font:700 9px/1.5rem system-ui,sans-serif;text-align:center;}";
  css += ".fb-file-chip .fb-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}";
  css += ".fb-file-chip .fb-remove-img{position:static;margin-left:auto;}";
  css += ".fb-item .fb-item-file{display:flex;margin:.15rem 0 .35rem;}.fb-panel .fb-file-chip{font-size:14px;max-width:100%;}.fb-panel .fb-file-icon{width:2rem;height:1.55rem;font-size:14px;line-height:1.55rem;}.fb-panel .fb-remove-img{font-size:14px;}";
  css += ".fb-status{display:inline-flex;align-items:center;gap:5px;font:600 14px/1.2 system-ui,sans-serif;white-space:nowrap;}.fb-status::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;}";
  css += ".fb-status-open{color:#087453;}";
  css += ".fb-status-done{color:#475569;}";
  css += ".fb-status-needs{color:#8a5700;}";
  css += ".fb-item.fb-done .fb-item-note{color:#8a94a6;}";
  css += ".fb-item.fb-needs{background:var(--pfb-surface);}";
  css += ".fb-item .fb-item-res{margin:0 0 .35rem;padding:.35rem .5rem;background:#f4f9f5;border-radius:7px;font-size:14px;color:#1d8843;}";
  css += ".fb-item .fb-item-ask{margin:.35rem 0;padding:.45rem .55rem;background:#fff4d6;border:1px solid #f0d78a;border-radius:7px;font-size:14px;color:#6b4e00;white-space:pre-wrap;}";
  css += ".fb-item .fb-item-ask strong{display:block;margin-bottom:.2rem;font-size:14px;letter-spacing:.04em;text-transform:uppercase;color:#9a6b00;}";
  css += ".fb-item .fb-reply{border:0;background:none;color:#9a6b00;font:600 11px system-ui,sans-serif;cursor:pointer;padding:0;}";
  css += ".fb-ip-bar{display:flex;align-items:center;gap:.35rem;padding:.45rem .85rem;background:#f8fafc;border-bottom:1px solid #eef1f6;overflow-x:auto;scrollbar-width:none;}";
  css += ".fb-ip-bar::-webkit-scrollbar{display:none;}";
  css += ".fb-ip-bar span{font:700 14px system-ui,sans-serif;color:#64748b;white-space:nowrap;margin-right:.15rem;}";
  css += ".fb-ip-pill{display:inline-flex;align-items:center;gap:3px;padding:.2rem .55rem;border-radius:999px;border:1px solid #d5dce8;background:#fff;font:600 14px system-ui,sans-serif;color:#475569;cursor:pointer;white-space:nowrap;transition:all .15s;}";
  css += ".fb-ip-pill:hover{border-color:#94a3b8;color:#0f172a;}";
  css += ".fb-ip-pill.fb-ip-active{background:#e2e8f0;border-color:#cbd5e1;color:#1e293b;}";
  css += "@keyframes fb-spin{to{transform:rotate(360deg)}}";
  css += "@keyframes fb-shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}";
  css += ".fb-preview-loading{display:flex;align-items:center;gap:12px;padding:10px 14px;margin-top:.55rem;border-radius:8px;border:1px dashed #cbd5e1;background:linear-gradient(90deg,#f8fafc 0%,#edf2f7 50%,#f8fafc 100%);background-size:200% 100%;animation:fb-shimmer 2s infinite ease-in-out;box-sizing:border-box;}";
  css += ".fb-capture-spinner{width:18px;height:18px;flex:0 0 18px;border:2.5px solid #cbd5e1;border-top-color:#003b95;border-radius:50%;animation:fb-spin .75s linear infinite;box-sizing:border-box;}";
  css += ".fb-preview-loading-text{display:flex;flex-direction:column;gap:2px;font:600 12px/1.3 system-ui,-apple-system,sans-serif;color:#1e293b;}";
  css += ".fb-preview-loading-sub{font-size:11px;font-weight:400;color:#64748b;}";
  css += ".fb-capture-btn .fb-capture-spinner{width:12px;height:12px;flex:0 0 12px;border-width:2px;border-top-color:currentColor;margin-right:4px;display:inline-block;vertical-align:middle;}";

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
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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

  function ensureHtml2Canvas(cb) {
    if (window.html2canvas) {
      cb(window.html2canvas);
      return;
    }
    var base = (typeof PFB !== "undefined" && PFB.pluginUrl) || "";
    var script = document.createElement("script");
    script.src = base ? base + "assets/js/html2canvas.min.js" : "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    script.onload = function () { cb(window.html2canvas); };
    script.onerror = function () {
      var s2 = document.createElement("script");
      s2.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
      s2.onload = function () { cb(window.html2canvas); };
      s2.onerror = function () { cb(null); };
      document.head.appendChild(s2);
    };
    document.head.appendChild(script);
  }

  function isTransparentColor(c) {
    if (!c || c === "transparent") return true;
    var m = String(c).match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/i);
    if (m && parseFloat(m[4]) === 0) return true;
    return false;
  }

  function getEffectiveBg(el) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var style = window.getComputedStyle(cur);
      var bg = style.backgroundColor;
      if (bg && !isTransparentColor(bg)) {
        return bg;
      }
      cur = cur.parentElement;
    }
    if (document.body) {
      var bodyBg = window.getComputedStyle(document.body).backgroundColor;
      if (bodyBg && !isTransparentColor(bodyBg)) return bodyBg;
    }
    if (document.documentElement) {
      var docBg = window.getComputedStyle(document.documentElement).backgroundColor;
      if (docBg && !isTransparentColor(docBg)) return docBg;
    }
    return "#ffffff";
  }

  function captureTarget(targetEl, cb) {
    if (!targetEl) {
      if (cb) cb(null);
      return;
    }
    ensureHtml2Canvas(function (h2c) {
      if (!h2c) {
        showToast("Failed to load screenshot library", "err");
        if (cb) cb(null);
        return;
      }

      // Hide selection and hover boxes so they don't appear in the image.
      // html2canvas ignoreElements handles skipping all [data-fb-ui] elements.
      // We explicitly keep .fb-form visible so the user sees the preloader and the form never blinks/flickers!
      var fbUIs = document.querySelectorAll(
        ".fb-selected-box, .fb-hover-box"
      );
      var prevStyles = [];
      fbUIs.forEach(function (ui, idx) {
        prevStyles[idx] = ui.style.visibility;
        ui.style.visibility = "hidden";
      });

      function restoreUI() {
        fbUIs.forEach(function (ui, idx) {
          ui.style.visibility = prevStyles[idx];
        });
      }

      var effectiveBg = getEffectiveBg(targetEl);
      var isGlobalOrBody =
        targetEl === document.body ||
        targetEl === document.documentElement;

      var opts = {
        logging: false,
        useCORS: true,
        allowTaint: true,
        scale: 1, // 1x scale is 4x faster and prevents canvas memory freeze on high-DPI
        backgroundColor: null,
        ignoreElements: function (node) {
          if (!node || node.nodeType !== 1) return false;
          if (
            node.hasAttribute("data-fb-ui") ||
            node.classList.contains("fb-selected-box") ||
            node.classList.contains("fb-hover-box") ||
            node.classList.contains("fb-form") ||
            node.classList.contains("fb-panel") ||
            node.classList.contains("fb-marker") ||
            node.classList.contains("fb-dock")
          ) {
            return true;
          }
          var tag = node.tagName.toLowerCase();
          if (
            tag === "script" ||
            tag === "noscript" ||
            tag === "iframe" ||
            tag === "video" ||
            tag === "audio"
          ) {
            return true;
          }
          return false;
        },
      };

      // For screen capture, capture the current visible viewport to avoid crawling 7000px+ height
      if (isGlobalOrBody) {
        opts.width = window.innerWidth;
        opts.height = window.innerHeight;
        opts.windowWidth = window.innerWidth;
        opts.windowHeight = window.innerHeight;
        opts.x = window.scrollX;
        opts.y = window.scrollY;
        opts.scrollX = 0;
        opts.scrollY = -window.scrollY;
      }

      // Yield execution to the browser so the preloader and UI changes paint first without freezing
      requestAnimationFrame(function () {
        setTimeout(function () {
          var finished = false;
          var timeoutTimer = setTimeout(function () {
            if (finished) return;
            finished = true;
            restoreUI();
            log("captureTarget timeout after 8s");
            showToast("Screenshot capture timed out", "err");
            if (cb) cb(null);
          }, 8000);

          try {
            h2c(targetEl, opts)
              .then(function (canvas) {
                if (finished) return;
                finished = true;
                clearTimeout(timeoutTimer);
                restoreUI();

                if (!canvas || !canvas.width || !canvas.height) {
                  if (cb) cb(null);
                  return;
                }

                // Composite onto a solid background canvas so transparent areas NEVER turn black in JPEG
                var bgCanvas = document.createElement("canvas");
                bgCanvas.width = canvas.width;
                bgCanvas.height = canvas.height;
                var ctx = bgCanvas.getContext("2d");
                ctx.fillStyle = effectiveBg || "#ffffff";
                ctx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
                ctx.drawImage(canvas, 0, 0);

                var dataUrl = bgCanvas.toDataURL("image/jpeg", 0.85);
                if (cb) cb(dataUrl);
              })
              .catch(function (err) {
                if (finished) return;
                finished = true;
                clearTimeout(timeoutTimer);
                restoreUI();
                log("screenshot error", err);
                showToast(
                  "Screenshot capture error: " + (err.message || "Unknown error"),
                  "err"
                );
                if (cb) cb(null);
              });
          } catch (err) {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutTimer);
            restoreUI();
            log("screenshot synchronous error", err);
            if (cb) cb(null);
          }
        }, 50);
      });
    });
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
  var doubleTapDelay = 300;
  var doubleTapDistance = 32;
  var lastTouchEnd = null;
  var lastInspectTap = null;
  var inspectTapTimer = null;
  var touchFirstView = window.matchMedia("(hover: none) and (pointer: coarse)");
  var hoverBox = null;
  var formEl = null;
  var stopPositioningForm = null;
  var markers = [];
  var loginWarningBannerEl = null;

  function showLoginWarningBanner() {
    if (loginWarningBannerEl) {
      loginWarningBannerEl.remove();
      loginWarningBannerEl = null;
    }
    loginWarningBannerEl = document.createElement("div");
    loginWarningBannerEl.className = "fb-unsaved-banner";
    loginWarningBannerEl.setAttribute("data-fb-ui", "");
    var redirectUrl = encodeURIComponent(window.location.href);
    var loginHref = LOGIN_URL || ("/wp-login.php?redirect_to=" + redirectUrl);
    loginWarningBannerEl.innerHTML =
      '<span class="fb-unsaved-icon">⚠️</span>' +
      '<div class="fb-unsaved-body">' +
        '<strong>Unsaved Feedback:</strong> Your notes are stored locally in this browser. You must log in to save them to the server.' +
      '</div>' +
      '<a class="fb-unsaved-btn" href="' + loginHref + '">Log In Now</a>' +
      '<button type="button" class="fb-unsaved-close" title="Dismiss">✕</button>';

    loginWarningBannerEl.querySelector(".fb-unsaved-close").addEventListener("click", function (e) {
      e.stopPropagation();
      if (loginWarningBannerEl) {
        loginWarningBannerEl.remove();
        loginWarningBannerEl = null;
      }
    });

    document.body.appendChild(loginWarningBannerEl);
  }

  var dock = document.createElement("nav");
  dock.className = "fb-dock";
  dock.setAttribute("aria-label", "Feedback toolbar");
  dock.setAttribute("data-fb-ui", "");
  document.body.appendChild(dock);

  var saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "fb-savebtn";
  saveBtn.setAttribute("data-fb-ui", "");
  saveBtn.textContent = "Save feedback";

  var toastEl = document.createElement("div");
  toastEl.className = "fb-toast";
  toastEl.setAttribute("role", "status");
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

  dock.innerHTML =
    '<div class="fb-inspect-tool"><button type="button" class="fb-tool" data-fb-inspect aria-label="Inspect" aria-pressed="false" title="Inspect: pick an element to leave feedback"><svg class="fb-inspect-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg></button>' +
    '<div class="fb-inspect-guide" id="pfb-inspect-help" role="status" hidden></div></div>' +
    '<button type="button" class="fb-tool" data-fb-new aria-label="New feedback" title="New feedback"><span class="fb-tool-symbol" aria-hidden="true">＋</span><span class="fb-tool-new">New</span></button>' +
    '<span class="fb-tool-divider" aria-hidden="true"></span>' +
    '<span class="fb-tool" data-fb-mode-status title="Inspect mode is off"><span class="fb-tool-dot fb-off" aria-hidden="true"></span><span>OFF</span></span>' +
    '<button type="button" class="fb-tool fb-toggle" aria-label="Feedback"><span class="fb-tool-symbol" aria-hidden="true">▤</span><span class="fb-count">0</span></button>';

  var toggle = dock.querySelector(".fb-toggle");
  var inspectBtn = dock.querySelector("[data-fb-inspect]");
  var newBtn = dock.querySelector("[data-fb-new]");
  inspectBtn.disabled = !ALLOW_NEW_FEEDBACK;
  newBtn.disabled = !ALLOW_NEW_FEEDBACK;
  var inspectGuide = dock.querySelector(".fb-inspect-guide");
  var modeStatus = dock.querySelector("[data-fb-mode-status]");
  var modeStatusDot = modeStatus.querySelector(".fb-tool-dot");
  var modeStatusText = modeStatus.lastElementChild;
  if (!ALLOW_NEW_FEEDBACK) modeStatus.title = "Adding feedback is disabled";

  function updateInspectGuide() {
    var visible = ALLOW_NEW_FEEDBACK && !formEl && (mode || !panel.classList.contains("fb-open"));
    var message = mode
      ? (touchFirstView.matches ? "Double-tap anywhere to turn off Feedback." : "Right-click anywhere to turn off Feedback.")
      : "Click to select an element and leave feedback.";
    if (inspectGuide.textContent !== message) inspectGuide.textContent = message;
    inspectGuide.hidden = !visible;
    if (visible) {
      inspectBtn.setAttribute("aria-describedby", "pfb-inspect-help");
    } else {
      inspectBtn.removeAttribute("aria-describedby");
    }
  }

  inspectBtn.addEventListener("click", function () {
    setMode(!mode);
  });
  newBtn.addEventListener("click", function () {
    openForm({ global: true });
  });

  var saving = false;
  var syncGeneration = 0;
  var panelSaveStatus = null;

  function renderPanelSaveStatus() {
    var status = panel.querySelector(".fb-panel-save-status");
    if (!status) return;
    status.textContent = panelSaveStatus ? panelSaveStatus.message :
      (isDirty() ? "Draft saved in this browser." : "Feedback on this page");
    status.dataset.kind = panelSaveStatus ? panelSaveStatus.kind : "";
  }

  function setPanelSaveStatus(message, kind) {
    panelSaveStatus = { message: message, kind: kind || "" };
    renderPanelSaveStatus();
  }

  /* Dirty → Save feedback; clean → Resave (always available for the client) */
  function renderSaveButton() {
    if (saving) return;
    var dirty = isDirty();
    var n = load().length;
    var pendingDeletes = loadDeleted().length;
    saveBtn.classList.remove("fb-ok", "fb-err");
    saveBtn.classList.toggle("fb-dirty", dirty);
    saveBtn.disabled = false;

    if (!LOGGED_IN) {
      if (dirty || n || LOGIN_URL) {
        saveBtn.classList.add("fb-login-btn");
        saveBtn.innerHTML = '🔒 <span>Log in to save</span>';
        saveBtn.title = "Login required: Please log in to save your feedback to the server.";
        saveBtn.disabled = false;
      } else {
        saveBtn.classList.remove("fb-login-btn");
        saveBtn.innerHTML = '🔒 <span>Save feedback</span>';
        saveBtn.title = "No notes yet · Log in to save to server";
        saveBtn.disabled = true;
      }
      return;
    }

    saveBtn.classList.remove("fb-login-btn");
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
    if (saving) return;
    if (!LOGGED_IN) {
      setPanelSaveStatus("Log in to save changes to the server.");
      renderSaveButton();
      return;
    }
    var entries = load();
    var deletedIds = loadDeleted();
    if (!entries.length && !deletedIds.length) {
      setPanelSaveStatus("No feedback to save yet.");
      renderSaveButton();
      return;
    }
    saving = true;
    syncGeneration += 1;
    saveBtn.disabled = true;
    saveBtn.classList.remove("fb-ok", "fb-err", "fb-dirty");
    saveBtn.textContent = "Saving…";
    setPanelSaveStatus("Saving to server…");
    syncToServer(entries, function (ok, info) {
      saving = false;
      if (ok) {
        refreshFeedbackView();
        if (info && info.newerDraft) {
          setPanelSaveStatus("Earlier changes saved. Newer changes are still local.");
          return;
        }
        saveBtn.classList.add("fb-ok");
        saveBtn.textContent = "Saved ✓";
        setPanelSaveStatus("Saved to server.", "success");
        setTimeout(renderSaveButton, 2200);
      } else {
        saveBtn.classList.add("fb-err");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save failed — retry";
        setPanelSaveStatus("Could not save to server. Your changes are still local.", "error");
        setTimeout(renderSaveButton, 3200);
      }
    });
  }

  saveBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (saving) return;
    if (!LOGGED_IN) {
      if (LOGIN_URL) window.location.assign(LOGIN_URL);
      else showLoginWarningBanner();
      return;
    }
    submitFinal();
  });

  var panel = document.createElement("div");
  panel.className = "fb-panel";
  panel.id = "pfb-inspector";
  toggle.setAttribute("aria-controls", panel.id);
  toggle.setAttribute("aria-expanded", "false");
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Feedback inspector");
  panel.setAttribute("data-fb-ui", "");
  document.body.appendChild(panel);

  function renderBadge() {
    var count = load().length;
    toggle.querySelector(".fb-count").textContent = count;
    toggle.title = "Open feedback inspector · " + count + " notes";
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
    var all = load();
    var visible = getFilteredEntries(all);
    visible.forEach(function (entry, i) {
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
      var vpTag = entry.viewport ? " [" + entry.viewport + "]" : "";
      var ipTag = entry.ip ? " (" + entry.ip + ")" : "";
      m.title = isDone
        ? "✓ Done (#" + (i + 1) + ")" + vpTag + ipTag + ": " + (entry.note || "") + (entry.resolution ? "\n→ " + entry.resolution : "") + "\n(Click to view / reopen)"
        : isNeeds && entry.question
          ? "Needs your reply (#" + (i + 1) + ")" + vpTag + ipTag + ": " + entry.question
          : "#" + (i + 1) + vpTag + ipTag + ": " + (entry.note || "");
      m._fbTarget = el;
      m._fbEntryId = entry.id;
      /* Click a marker → open the panel with that entry */
      m.addEventListener("click", function (e) {
        e.stopPropagation();
        panelQuery = "";
        panelStatus = "";
        openPanel();
        if (isDone) {
          stopEdit();
          renderPanel();
          var itemEl = panel.querySelector('.fb-item[data-fb-id="' + entry.id + '"]');
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
          var realIdx = findEntryIndex(entry.id);
          startEdit(realIdx);
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
    log("markers rendered", markers.length + "/" + visible.length + " (ip filter: " + activeIpFilter + ")");
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
    captureDraftNote();
    renderPanel();
    panel.classList.add("fb-open");
    toggle.setAttribute("aria-expanded", "true");
    updateInspectGuide();
  }
  function closePanel() {
    captureDraftNote();
    panel.classList.remove("fb-open");
    toggle.setAttribute("aria-expanded", "false");
    updateInspectGuide();
  }

  var editingId = null;
  /* Pending changes while editing: note/images/files = undefined → untouched */
  var editingDraft = null;

  function startEdit(i) {
    var entry = load()[i];
    editingId = entry ? entry.id : null;
    editingDraft = { note: undefined, images: undefined, files: undefined };
  }
  function stopEdit() {
    editingId = null;
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
      var cur = load().find(function (entry) { return entry.id === editingId; });
      editingDraft.images = cur ? imagesOf(cur).slice() : [];
    }
    return editingDraft.images;
  }

  function ensureDraftFiles() {
    if (!editingDraft) return [];
    if (editingDraft.files === undefined) {
      var cur = load().find(function (entry) { return entry.id === editingId; });
      editingDraft.files = cur ? filesOf(cur).map(function (f) {
        return Object.assign({}, f);
      }) : [];
    }
    return editingDraft.files;
  }

  function draftAttachCount() {
    return ensureDraftImages().length + ensureDraftFiles().length;
  }

  var panelQuery = "";
  var panelStatus = "";
  var locatedTarget = null;
  var locateTimer;

  function refreshFeedbackView() {
    renderBadge();
    renderMarkers();
    renderSaveButton();
    if (panel.classList.contains("fb-open")) {
      captureDraftNote();
      renderPanel();
    }
  }

  function panelUsesFigUI() {
    return !!window.customElements && !!customElements.get("fig-menu") &&
      getComputedStyle(panel).getPropertyValue("--pfb-figui-ready").trim() === "1";
  }

  var panelIconPaths = {
    add: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    options: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    locate: '<circle cx="12" cy="12" r="6"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
    images: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1"/><path d="m3 17 5-5 4 4 4-4 5 5"/>'
  };

  function panelIcon(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  function panelIconButton(useFig, label, attrs, icon, variant, count) {
    if (!useFig) {
      return '<button type="button" ' + attrs + ' aria-label="' + label + '" title="' + label + '">' +
        panelIcon(icon) + (count || "") + '</button>';
    }
    return '<fig-tooltip text="' + label + '"><fig-button ' + (count ? '' : 'icon ') +
      'variant="' + (variant || "ghost") + '" ' + attrs + ' aria-label="' + label + '">' +
      panelIcon(icon) + (count || "") + '</fig-button></fig-tooltip>';
  }

  function renderPanelOptions(useFig, hasEntries) {
    var options = [["export", "Export JSON"], ["reload", "Reload server"], ["copy", "Copy JSON"]];
    if (hasEntries) options.push(["clear-all", "Clear all"]);
    if (useFig) {
      return '<fig-menu position="bottom right" class="fb-panel-options">' +
        '<fig-button fig-menu-trigger icon variant="ghost" aria-label="Feedback options" title="Feedback options">' +
        panelIcon(panelIconPaths.options) + '</fig-button>' +
        options.map(function (option) {
          return '<fig-menu-item value="' + option[0] + '" data-fb-' + option[0] + '>' + option[1] + '</fig-menu-item>';
        }).join("") + '</fig-menu>';
    }
    return '<details class="fb-panel-options"><summary aria-label="Feedback options" title="Feedback options">⚙</summary>' +
      '<div class="fb-panel-menu">' + options.map(function (option) {
        return '<button type="button" data-fb-' + option[0] + '>' + option[1] + '</button>';
      }).join("") + '</div></details>';
  }

  function renderPanel() {
    var allEntries = load();
    var allIps = getAllIps(allEntries);
    var myCount = allEntries.filter(function (entry) {
      return !entry.ip || entry.ip === CURRENT_IP;
    }).length;
    var useFig = panelUsesFigUI();
    var head =
      '<div class="fb-panel-head"><div class="fb-panel-heading"><strong>Feedback</strong>' +
      '<span class="fb-panel-count" aria-live="polite"></span></div><div class="fb-actions">' +
      (ALLOW_NEW_FEEDBACK ? panelIconButton(useFig, "Add feedback", 'class="fb-add" data-fb-add', panelIconPaths.add, "primary") : "") +
      renderPanelOptions(useFig, allEntries.length > 0) +
      panelIconButton(useFig, "Close feedback", 'class="fb-panel-icon" data-fb-close', panelIconPaths.close) +
      '</div></div>';
    var ipBar = "";
    if (CURRENT_IP) {
      ipBar = '<div class="fb-panel-segment" role="group" aria-label="Feedback scope">' +
        '<button type="button" data-fb-filter-ip="my" aria-pressed="' + (activeIpFilter === "my") + '">My feedback (' + myCount + ')</button>' +
        '<button type="button" data-fb-filter-ip="all" aria-pressed="' + (activeIpFilter === "all") + '">All feedback (' + allEntries.length + ')</button></div>';
      var otherIps = allIps.filter(function (ip) { return ip !== CURRENT_IP; });
      if (otherIps.length) {
        ipBar += '<div class="fb-ip-bar"><span>IP</span>';
        otherIps.forEach(function (ip) {
          var count = allEntries.filter(function (entry) { return entry.ip === ip; }).length;
          ipBar += '<button type="button" class="fb-ip-pill' + (activeIpFilter === ip ? " fb-ip-active" : "") +
            '" data-fb-filter-ip="' + ip + '" aria-pressed="' + (activeIpFilter === ip) + '">' + ip + ' (' + count + ')</button>';
        });
        ipBar += '</div>';
      }
    }
    var list = panel.querySelector(".fb-panel-list");
    var scrollTop = list ? list.scrollTop : 0;
    panel.innerHTML = head + ipBar +
      '<div class="fb-panel-filters"><input type="search" aria-label="Search feedback" placeholder="Search feedback…" data-fb-search>' +
      '<select aria-label="Filter by status" data-fb-status>' +
      '<option value="">All statuses</option><option value="open">Open</option>' +
      '<option value="needs_info">Needs reply</option><option value="done">Resolved</option></select></div>' +
      '<div class="fb-panel-list"></div><div class="fb-panel-foot">' +
      '<span class="fb-panel-save-status" role="status" aria-atomic="true"></span><span data-fb-save-slot></span></div>';
    panel.querySelector("[data-fb-save-slot]").appendChild(saveBtn);
    renderPanelSaveStatus();
    panel.querySelector("[data-fb-search]").value = panelQuery;
    panel.querySelector("[data-fb-status]").value = panelStatus;
    renderPanelList(allEntries);
    panel.querySelector(".fb-panel-list").scrollTop = scrollTop;
  }

  function escapePanelHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function renderLocateButton(entry, id, useFig) {
    if (entry.scope === "global" || entry.selector === "(global)" || !entry.selector) return "";
    return panelIconButton(useFig, "Locate on page", 'class="fb-item-context" data-fb-locate="' + id + '"', panelIconPaths.locate);
  }

  var feedbackDateFormat = new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: "UTC"
  });

  function renderFeedbackDate(entry) {
    var date = new Date(entry.ts || entry.date || NaN);
    if (isNaN(date.getTime()) && entry.date) date = new Date(entry.date);
    if (isNaN(date.getTime())) return "";
    var iso = date.toISOString();
    var full = iso.slice(0, 19).replace("T", " ") + " UTC";
    var label = feedbackDateFormat.format(date).replace(", ", " · ") + " UTC";
    return '<time class="fb-item-date" datetime="' + iso + '" title="' + full + '">' + label + '</time>';
  }

  var feedbackActionIcons = {
    edit: '<path d="m14 5 5 5M5 19l4-.8L19 8a2.1 2.1 0 0 0-3-3L6 15z"/>',
    reply: '<path d="m10 8-5 5 5 5m-5-5h10a4 4 0 0 0 4-4V6"/>',
    reopen: '<path d="M5 11a7 7 0 1 1 2 6m-2-11v5h5"/>',
    delete: '<path d="M4 7h16m-10 0V4h4v3m4 0-1 13H7L6 7m4 4v5m4-5v5"/>'
  };

  function renderFeedbackAction(action, label, id, useFig) {
    return panelIconButton(useFig, label, 'data-fb-' + action + '="' + id + '"', feedbackActionIcons[action],
      action === "delete" ? "destructiveGhost" : "ghost");
  }

  function renderPanelList(allEntries) {
    var useFig = panelUsesFigUI();
    var query = panelQuery.trim().toLowerCase();
    var scopedEntries = getFilteredEntries(allEntries);
    var visibleEntries = scopedEntries.filter(function (entry) {
      var status = entry.status === "done" || entry.status === "needs_info" ? entry.status : "open";
      return (!panelStatus || panelStatus === status) &&
        (!query || [entry.note, entry.selector, entry.question, entry.resolution, entry.ip,
          entry.scope === "global" ? "General feedback" : ""].some(function (field) {
          return String(field || "").toLowerCase().indexOf(query) !== -1;
        }));
    });
    var body = visibleEntries.length
      ? visibleEntries
          .map(function (e) {
            var done = e.status === "done";
            var needs = e.status === "needs_info";
            var statusClass = done
              ? "fb-status-done"
              : needs
                ? "fb-status-needs"
                : "fb-status-open";
            var statusLabel = done ? "Resolved" : needs ? "Needs reply" : "Open";
            var isCurEditing = editingId !== null && editingId === e.id;
            var id = escapePanelHtml(e.id);
            var number = scopedEntries.indexOf(e) + 1;
            var action = done ? "reopen" : needs ? "reply" : "edit";
            var actionLabel = done ? "Reopen" : needs ? "Reply" : "Edit";
            var imageCount = (isCurEditing && editingDraft.images !== undefined ? editingDraft.images : imagesOf(e)).length;
            return (
              '<div class="fb-item' +
              (done ? " fb-done" : "") +
              (needs ? " fb-needs" : "") + (isCurEditing ? " fb-item-editing" : "") +
              '" data-fb-id="' + id + '">' +
              '<div class="fb-item-top"><span class="fb-item-number">#' + number + '</span><div class="fb-item-main">' +
              (isCurEditing ? "" : '<div class="fb-item-note">' + escapePanelHtml(e.note) + '</div>') +
              '<div class="fb-item-heading"><span class="fb-status ' + statusClass + '">' + statusLabel + '</span>' +
              (e.scope === "global" || e.selector === "(global)" ? '<span class="fb-item-scope">· Page-wide</span>' : "") +
              renderFeedbackDate(e) +
              (imageCount ? panelIconButton(useFig, "View " + imageCount + (imageCount === 1 ? " image" : " images"),
                'class="fb-image-button" data-fb-images="' + id + '"', panelIconPaths.images, "ghost", imageCount) : "") +
              renderLocateButton(e, id, useFig) + '</div></div>' +
              (isCurEditing ? "" : '<div class="fb-item-actions">' +
                renderFeedbackAction(action, actionLabel, id, useFig) + renderFeedbackAction("delete", "Delete", id, useFig) +
                '</div>') + "</div>" +
              (isCurEditing
                ? (function () {
                    var noteVal =
                      editingDraft && editingDraft.note !== undefined
                        ? editingDraft.note
                        : e.note || "";
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
                      '<div class="fb-edit-composer"><textarea class="fb-edit-ta" rows="2" aria-label="Edit feedback" placeholder="' +
                      (needs
                        ? "Reply here with more detail…"
                        : "Update your note…") +
                      '">' +
                      escapePanelHtml(noteVal) +
                      "</textarea>" +
                      docs
                        .map(function (f, j) {
                          return fileChipHtml(f, {
                            noLink: true,
                            rmAttr: 'data-fb-edit-rmfile="' + j + '"',
                          });
                        })
                        .join("") +
                      '<div class="fb-edit-toolbar"><label class="fb-attach-btn" title="Attach files">' +
                      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"/></svg>' +
                      '<input type="file" aria-label="Attach files" accept="' + FILE_ACCEPT + '" multiple class="fb-edit-file"></label>' +
                      '<div class="fb-edit-actions"><button type="button" aria-label="Cancel" title="Cancel" data-fb-edit-cancel>' +
                      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
                      '<button type="button" data-fb-edit-save="' + id + '" title="' + (needs ? "Send reply" : "Save edit") +
                      '" aria-label="' + (needs ? "Send reply" : "Save edit") + '" aria-keyshortcuts="Control+Enter Meta+Enter">' +
                      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></div></div></div>'
                    );
                  })()
                : filesOf(e)
                    .map(function (f) {
                      return (
                        '<div class="fb-item-file">' +
                        fileChipHtml(f) +
                        "</div>"
                      );
                    })
                    .join("")) +
              (needs && e.question && !isCurEditing
                ? '<div class="fb-item-ask"><strong>Question from the team</strong>' +
                  String(e.question).replace(/</g, "&lt;") +
                  "</div>"
                : "") +
              (done && e.resolution
                ? '<div class="fb-item-res">→ ' +
                  String(e.resolution).replace(/</g, "&lt;") +
                  "</div>"
                : "") +
              "</div>"
            );
          })
          .join("")
      : allEntries.length
        ? '<div class="fb-empty">No feedback matches the current filters.</div>'
        : ALLOW_NEW_FEEDBACK
          ? '<div class="fb-empty">No feedback yet. Select Add feedback to create a note.</div>'
          : '<div class="fb-empty">No feedback on this page. Adding new notes is paused.</div>';
    panel.querySelector(".fb-panel-count").textContent = visibleEntries.length;
    panel.querySelector(".fb-panel-list").innerHTML = body;
  }

  panel.addEventListener("input", function (event) {
    if (!event.target.hasAttribute("data-fb-search")) return;
    captureDraftNote();
    panelQuery = event.target.value;
    renderPanelList(load());
  });

  panel.addEventListener("change", function (event) {
    if (!event.target.hasAttribute("data-fb-status")) return;
    captureDraftNote();
    panelStatus = event.target.value;
    renderPanelList(load());
  });

  function openFeedbackImages(button) {
    var entry = load()[findEntryIndex(button.getAttribute("data-fb-images"))];
    if (!entry) return;
    var editable = entry.id === editingId && !!editingDraft;
    var images = editable ? ensureDraftImages() : imagesOf(entry);
    if (!images.length) return;
    var index = 0;
    var changed = false;
    var dialog = document.createElement("dialog");
    dialog.className = "fb-image-dialog";
    dialog.setAttribute("data-fb-ui", "");
    dialog.setAttribute("aria-labelledby", "pfb-image-title");
    dialog.innerHTML =
      '<div class="fb-image-dialog-head"><strong id="pfb-image-title">Feedback images</strong>' +
      '<button type="button" data-image-close aria-label="Close images" autofocus>×</button></div>' +
      '<img alt=""><div class="fb-image-dialog-controls">' +
      '<button type="button" data-image-prev aria-label="Previous image">‹</button>' +
      '<span role="status"></span><button type="button" data-image-next aria-label="Next image">›</button>' +
      (editable ? '<button type="button" data-image-remove>Remove</button>' : "") + '</div>';
    var image = dialog.querySelector("img");
    var count = dialog.querySelector("[role=status]");
    var prev = dialog.querySelector("[data-image-prev]");
    var next = dialog.querySelector("[data-image-next]");
    var controls = dialog.querySelector(".fb-image-dialog-controls");

    function showImage() {
      image.src = resolveImg(images[index]);
      image.alt = "Feedback image " + (index + 1);
      count.textContent = (index + 1) + " / " + images.length;
      prev.disabled = index === 0;
      next.disabled = index === images.length - 1;
      controls.hidden = images.length === 1 && !editable;
    }

    function isBackdrop(event) {
      if (event.target !== dialog) return false;
      var box = dialog.getBoundingClientRect();
      return event.clientX < box.left || event.clientX >= box.right ||
        event.clientY < box.top || event.clientY >= box.bottom;
    }

    var pressedBackdrop = false;
    dialog.addEventListener("pointerdown", function (event) {
      pressedBackdrop = isBackdrop(event);
    });
    dialog.addEventListener("click", function (event) {
      var clicked = event.target;
      var closeFromBackdrop = pressedBackdrop && isBackdrop(event);
      pressedBackdrop = false;
      if (clicked.hasAttribute("data-image-close") || closeFromBackdrop) dialog.close();
      else if (clicked === prev && index > 0) {
        index -= 1;
        showImage();
      } else if (clicked === next && index < images.length - 1) {
        index += 1;
        showImage();
      } else if (editable && clicked.hasAttribute("data-image-remove")) {
        captureDraftNote();
        images.splice(index, 1);
        changed = true;
        if (!images.length) dialog.close();
        else {
          index = Math.min(index, images.length - 1);
          showImage();
        }
      }
    });
    dialog.addEventListener("keydown", function (event) {
      if (event.key === "Escape") event.stopPropagation();
    });
    dialog.addEventListener("close", function () {
      dialog.remove();
      if (changed) {
        renderPanel();
        var editor = panel.querySelector(".fb-edit-ta");
        if (editor) editor.focus();
      }
    });
    document.body.appendChild(dialog);
    showImage();
    dialog.showModal();
  }

  panel.addEventListener("keydown", function (event) {
    if (!event.target.classList.contains("fb-edit-ta") || event.key !== "Enter" ||
        !(event.ctrlKey || event.metaKey) || event.isComposing) return;
    event.preventDefault();
    event.target.closest(".fb-edit-composer").querySelector("[data-fb-edit-save]").click();
  });

  panel.addEventListener("click", function (event) {
    handlePanelAction(event.target.closest("button,fig-button") || event.target);
  });
  panel.addEventListener("change", function (event) {
    var item = event.detail && event.detail.item;
    if (event.target.matches("fig-menu.fb-panel-options") && item && item.parentElement === event.target) {
      handlePanelAction(item);
    }
  });

  function handlePanelAction(t) {
    var locate = t.closest("[data-fb-locate]");
    if (locate) {
      var entry = load()[findEntryIndex(locate.getAttribute("data-fb-locate"))];
      var target = entry && resolveTargetElement(entry.selector);
      if (!target || isUi(target) || !target.getClientRects().length) {
        showToast("This element is no longer visible on the page.", "err");
        return;
      }
      closePanel();
      target.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
      });
      if (locatedTarget) locatedTarget.classList.remove("fb-located-target");
      window.clearTimeout(locateTimer);
      locatedTarget = target;
      locatedTarget.classList.add("fb-located-target");
      locateTimer = window.setTimeout(function () {
        locatedTarget.classList.remove("fb-located-target");
        locatedTarget = null;
      }, 3000);
      return;
    }
    if (t.closest("[data-fb-add]")) {
      openForm({ global: true });
      return;
    }
    var ipBtn = t.closest ? t.closest("[data-fb-filter-ip]") : null;
    if (ipBtn) {
      var targetIp = ipBtn.getAttribute("data-fb-filter-ip");
      if (targetIp) {
        captureDraftNote();
        activeIpFilter = targetIp;
        try { localStorage.setItem(IP_FILTER_KEY, targetIp); } catch (err) {}
        renderMarkers();
        renderPanel();
      }
      return;
    }
    if (t.hasAttribute("data-fb-reload")) {
      if (t.disabled) return;
      t.disabled = true;
      pullFromServer(function (ok) {
        t.disabled = false;
        if (ok) {
          refreshFeedbackView();
          showToast("Refreshed feedback from the server.", "ok");
        } else {
          showToast("Could not refresh feedback. Please try again.", "err");
        }
      });
      return;
    }
    var imageButton = t.closest("[data-fb-images]");
    if (imageButton) {
      openFeedbackImages(imageButton);
      return;
    }
    if (t.hasAttribute("data-fb-close")) closePanel();
    if (t.hasAttribute("data-fb-delete")) {
      var delIdx = findEntryIndex(t.getAttribute("data-fb-delete"));
      var delAll = load();
      var delItem = delAll[delIdx];
      if (!delItem) return;
      var preview = (delItem.note || delItem.selector || "this note").slice(0, 80);
      if (
        !window.confirm(
          "Delete this feedback note and its attached images?\n\n“" +
            preview +
            "”"
        )
      ) {
        return;
      }
      if (editingId === delItem.id) stopEdit();
      queueDeleteId(delItem.id);
      delAll.splice(delIdx, 1);
      save(delAll);
      renderPanel();
      submitFinal();
    }
    if (t.hasAttribute("data-fb-clear-all")) {
      var clearList = load();
      if (!clearList.length) return;
      if (
        !window.confirm(
          "Delete ALL " +
            clearList.length +
            " feedback note(s) on this page?\n\nAll notes and their attached screenshot files in the feedback folder will be permanently deleted."
        )
      ) {
        return;
      }
      stopEdit();
      clearList.forEach(function (row) {
        if (row && row.id) queueDeleteId(row.id);
      });
      save([]);
      renderPanel();
      submitFinal();
    }
    if (t.hasAttribute("data-fb-edit") || t.hasAttribute("data-fb-reply")) {
      var editIdx = findEntryIndex(
        t.getAttribute("data-fb-edit") || t.getAttribute("data-fb-reply")
      );
      startEdit(editIdx);
      renderPanel();
      var ta = panel.querySelector(".fb-edit-ta");
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
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
      var idx = findEntryIndex(t.getAttribute("data-fb-edit-save"));
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
      var reopenIdx = findEntryIndex(t.getAttribute("data-fb-reopen"));
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
          t.textContent = "Copy JSON";
        }, 1200);
      });
    }
  }

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
    resetInspectTap();
    lastTouchEnd = null;
    mode = !!on && ALLOW_NEW_FEEDBACK;
    document.body.classList.toggle("fb-mode", mode);
    inspectBtn.setAttribute("aria-pressed", String(mode));
    inspectBtn.title = mode ? "Exit Inspect mode" : "Inspect: pick an element to leave feedback";
    modeStatusText.textContent = mode ? "ON" : "OFF";
    modeStatusDot.classList.toggle("fb-off", !mode);
    modeStatus.title = mode ? "Inspect mode is on" : "Inspect mode is off";
    removeHover();
    removeForm();
    closePanel();
  }

  toggle.addEventListener("click", function (e) {
    e.stopPropagation();
    if (panel.classList.contains("fb-open")) closePanel();
    else openPanel();
  });

  function removeHover() {
    if (hoverBox) {
      hoverBox.remove();
      hoverBox = null;
    }
  }

  function isUi(el) {
    return (
      el.closest(
        "[data-fb-ui], .fb-form, .fb-selected-box, .fb-hover-box, .fb-panel, .fb-marker, .fb-dock, .fb-toast"
      ) !== null
    );
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

  function positionFeedbackForm(form, target, pointer) {
    var viewport = window.visualViewport;
    var margin = 10;
    var gap = 8;
    var offset = null;
    if (pointer && target) {
      var initialAnchor = target.getBoundingClientRect();
      offset = { x: pointer.x - initialAnchor.left, y: pointer.y - initialAnchor.top };
    }

    function place() {
      var x = viewport ? viewport.offsetLeft : 0;
      var y = viewport ? viewport.offsetTop : 0;
      var width = viewport ? viewport.width : window.innerWidth;
      var height = viewport ? viewport.height : window.innerHeight;
      var minX = x + margin;
      var minY = y + margin;
      var bottom = y + height - margin;
      var toolbar = dock.getBoundingClientRect();
      if (toolbar.top > minY && toolbar.top < bottom && toolbar.bottom <= y + height) {
        bottom = toolbar.top - gap;
      }

      form.style.maxWidth = Math.max(0, width - 2 * margin) + "px";
      form.style.maxHeight = Math.max(0, bottom - minY) + "px";
      var box = form.getBoundingClientRect();
      var maxX = x + width - margin - box.width;
      var maxY = bottom - box.height;
      var left = x + (width - box.width) / 2;
      var top = minY + Math.max(0, (maxY - minY) / 3);

      if (target && target.isConnected) {
        var anchor = target.getBoundingClientRect();
        if (offset) {
          var clickX = anchor.left + offset.x;
          var clickY = anchor.top + offset.y;
          left = clickX + gap <= maxX ? clickX + gap : clickX - gap - box.width;
          top = clickY + gap <= maxY ? clickY + gap : clickY - gap - box.height;
        } else {
          left = anchor.left;
          var below = anchor.bottom + gap;
          var above = anchor.top - gap - box.height;
          if (below <= maxY) top = below;
          else if (above >= minY) top = above;
          else {
            top = anchor.top;
            var right = anchor.right + gap;
            var leftOfTarget = anchor.left - gap - box.width;
            if (right <= maxX) left = right;
            else if (leftOfTarget >= minX) left = leftOfTarget;
          }
        }
      }

      form.style.left = Math.max(minX, Math.min(left, maxX)) + "px";
      form.style.top = Math.max(minY, Math.min(top, maxY)) + "px";
    }

    place();
    var observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (observer) observer.observe(form);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    if (viewport) {
      viewport.addEventListener("resize", place);
      viewport.addEventListener("scroll", place);
    }
    return function () {
      if (observer) observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
      if (viewport) {
        viewport.removeEventListener("resize", place);
        viewport.removeEventListener("scroll", place);
      }
    };
  }

  function removeForm() {
    if (stopPositioningForm) {
      stopPositioningForm();
      stopPositioningForm = null;
    }
    if (formEl) {
      formEl.remove();
      formEl = null;
    }
    document.querySelectorAll(".fb-selected-box").forEach(function (b) {
      b.remove();
    });
    updateInspectGuide();
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
    var currentVp = window.innerWidth + "×" + window.innerHeight;
    formEl.innerHTML =
      '<div class="fb-form-content"><textarea rows="1" aria-label="' +
      (isGlobal ? "General feedback" : "Element feedback") + '" placeholder="Add feedback…"></textarea>' +
      '<div class="fb-previews"></div></div>' +
      '<div class="fb-row"><button type="button" class="fb-compose-attach" aria-label="Add image or file" title="Add image or file" aria-controls="pfb-compose-attachments" aria-expanded="false">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"/></svg></button>' +
      '<div id="pfb-compose-attachments" class="fb-form-attachments" hidden>' +
      '<div class="fb-attach-row">' +
      '<button type="button" class="fb-capture-btn" title="' +
      (isGlobal ? "Take a screenshot of current screen" : "Take a screenshot of this element") +
      '" aria-label="' + (isGlobal ? "Capture screen" : "Capture element") + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="3"/></svg></button>' +
      '<label class="fb-attach-btn" title="Attach files">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/></svg>' +
      '<input type="file" aria-label="Attach files" accept="' +
      FILE_ACCEPT +
      '" multiple /></label>' +
      (!isGlobal
        ? '<label class="fb-auto-cap-lbl" title="Automatically capture screenshot of selected element"><input type="checkbox" class="fb-auto-cap-cb" aria-label="Auto-capture"><span class="fb-auto-switch" aria-hidden="true"></span>Auto</label>'
        : "") +
      "</div></div>" +
      '<div class="fb-compose-actions"><button type="button" class="fb-cancel" aria-label="Cancel" title="Cancel">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
      '<button type="button" class="fb-save" aria-label="Save draft" title="Save draft (Ctrl or Command + Enter)" aria-keyshortcuts="Control+Enter Meta+Enter" disabled>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></div></div>';

    document.body.appendChild(formEl);
    stopPositioningForm = positionFeedbackForm(formEl, el, opts.pointer);
    updateInspectGuide();
    var ta = formEl.querySelector("textarea");
    ta.focus({ preventScroll: true });

    var attachedImages = [];
    var attachedFiles = [];
    var fileInput = formEl.querySelector('input[type="file"]');
    var previews = formEl.querySelector(".fb-previews");
    var attachments = formEl.querySelector(".fb-form-attachments");
    var attachmentButton = formEl.querySelector(".fb-compose-attach");
    var draftButton = formEl.querySelector(".fb-save");
    var composer = formEl;

    var isCapturing = false;

    function updateComposer() {
      var hasAttachment = attachedImages.length > 0 || attachedFiles.length > 0;
      var expanded = !!ta.value || !attachments.hidden || hasAttachment || isCapturing;
      composer.classList.toggle("fb-compose-expanded", expanded);
      ta.style.height = "";
      if (expanded) ta.style.height = Math.min(120, ta.scrollHeight) + "px";
      attachmentButton.setAttribute("aria-expanded", String(!attachments.hidden));
      draftButton.disabled = isCapturing || (!ta.value.trim() && !hasAttachment);
    }
    ta.addEventListener("input", updateComposer);
    attachmentButton.addEventListener("click", function () {
      attachments.hidden = !attachments.hidden;
      updateComposer();
    });

    function showCaptureLoading() {
      var loader = previews.querySelector(".fb-preview-loading");
      if (!loader) {
        loader = document.createElement("div");
        loader.className = "fb-preview-loading";
        loader.innerHTML =
          '<div class="fb-capture-spinner"></div>' +
          '<div class="fb-preview-loading-text">' +
            '<span>📸 Capturing screenshot...</span>' +
            '<span class="fb-preview-loading-sub">Rendering image preview</span>' +
          '</div>';
        previews.appendChild(loader);
      }
    }

    function hideCaptureLoading() {
      var loader = previews.querySelector(".fb-preview-loading");
      if (loader) loader.remove();
    }

    function renderPreviews() {
      var html =
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

      previews.innerHTML = html;
      updateComposer();
      if (isCapturing) {
        showCaptureLoading();
      }
    }

    function addAttachment(att) {
      if (!att) return;
      attachments.hidden = false;
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

    var captureBtn = formEl.querySelector(".fb-capture-btn");
    var captureIcon = captureBtn.innerHTML;
    var autoCapCb = formEl.querySelector(".fb-auto-cap-cb");
    log("openForm mounted", { hasCaptureBtn: !!captureBtn, hasAutoCapCb: !!autoCapCb });

    function doCapture() {
      if (isCapturing) return;
      isCapturing = true;
      updateComposer();
      log("doCapture starting");
      if (captureBtn) {
        captureBtn.disabled = true;
        captureBtn.innerHTML =
          '<span class="fb-capture-spinner" aria-hidden="true"></span>';
        captureBtn.setAttribute("aria-label", "Capturing screenshot");
      }
      showCaptureLoading();

      var targetToCapture = el || document.body;
      captureTarget(targetToCapture, function (dataUrl) {
        isCapturing = false;
        updateComposer();
        hideCaptureLoading();
        log("captureTarget callback received", { hasDataUrl: !!dataUrl });
        if (captureBtn) {
          captureBtn.disabled = false;
          captureBtn.innerHTML = captureIcon;
          var captureLabel = (dataUrl ? "Recapture " : "Capture ") + (isGlobal ? "screen" : "element");
          captureBtn.setAttribute("aria-label", captureLabel);
          captureBtn.title = captureLabel;
        }
        if (dataUrl) {
          addAttachment({ kind: "image", data: dataUrl });
          showToast(isGlobal ? "✓ Screen captured!" : "✓ Element captured!", "ok");
        }
      });
    }

    if (captureBtn) {
      captureBtn.addEventListener("click", function (e) {
        log("captureBtn clicked!");
        e.stopPropagation();
        doCapture();
      });
    }

    if (autoCapCb) {
      autoCapCb.addEventListener("change", function () {
        if (autoCapCb.checked && attachedImages.length === 0) {
          doCapture();
        }
      });
    }

    ta.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      event.preventDefault();
      draftButton.click();
    });

    formEl.querySelector(".fb-cancel").addEventListener("click", removeForm);
    draftButton.addEventListener("click", function () {
      if (isCapturing) {
        showToast("Please wait for screenshot to finish capturing...", "err");
        return;
      }
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
        viewport: currentVp,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        ip: CURRENT_IP,
      };
      if (attachedImages.length) {
        entry.images = attachedImages.slice();
        entry.image = attachedImages[0];
      }
      if (attachedFiles.length) {
        entry.files = attachedFiles.map(function (f) {
          return { name: f.name, data: f.data };
        });
      }
      entries.push(entry);
      if (activeIpFilter !== "my" && activeIpFilter !== "all" && activeIpFilter !== CURRENT_IP) {
        activeIpFilter = "my";
        try { localStorage.setItem(IP_FILTER_KEY, "my"); } catch (err) {}
      }
      try {
        save(entries);
      } catch (err) {
        alert("Storage is full — Export JSON first, or delete some notes.");
        return;
      }
      removeForm();
      panelQuery = "";
      panelStatus = "";
      openPanel();
    });
  }


  function resetInspectTap() {
    window.clearTimeout(inspectTapTimer);
    inspectTapTimer = null;
    lastInspectTap = null;
  }

  function nearbyTap(point, event, distance) {
    return Math.hypot(point.x - event.clientX, point.y - event.clientY) <= distance;
  }

  // Some touch browsers report a MouseEvent rather than a PointerEvent for click.
  document.addEventListener("touchend", function (event) {
    if (!mode || event.touches.length || event.changedTouches.length !== 1) return;
    var point = event.changedTouches[0];
    lastTouchEnd = { x: point.clientX, y: point.clientY, time: performance.now() };
  }, { capture: true, passive: true });

  window.addEventListener("scroll", function () {
    if (lastInspectTap) resetInspectTap();
  }, { passive: true });

  function isTouchClick(event, now) {
    if (event.pointerType) return event.pointerType === "touch";
    if (event.sourceCapabilities) return event.sourceCapabilities.firesTouchEvents;
    return event.detail > 0 && lastTouchEnd && now - lastTouchEnd.time <= 450 &&
      nearbyTap(lastTouchEnd, event, 8);
  }

  document.addEventListener("click", function (event) {
    if (!mode) return;
    var el = event.target;
    var ui = isUi(el);
    var now = performance.now();
    var touch = isTouchClick(event, now);
    lastTouchEnd = null;
    if (touch && lastInspectTap && now - lastInspectTap.time <= doubleTapDelay &&
        nearbyTap(lastInspectTap, event, doubleTapDistance)) {
      event.preventDefault();
      event.stopPropagation();
      setMode(false);
      return;
    }

    resetInspectTap();
    if (touch) {
      lastInspectTap = { x: event.clientX, y: event.clientY, time: now };
      inspectTapTimer = window.setTimeout(function () {
        resetInspectTap();
        if (mode && !ui && !formEl && el.isConnected) {
          closePanel();
          openForm({ el: el, pointer: { x: event.clientX, y: event.clientY } });
        }
      }, doubleTapDelay);
    }
    if (ui) return;
    event.preventDefault();
    event.stopPropagation();
    if (!touch && !formEl) {
      closePanel();
      openForm({
        el: el,
        pointer: event.detail > 0 ? { x: event.clientX, y: event.clientY } : null
      });
    }
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !e.defaultPrevented) {
      if (mode) setMode(false);
      else {
        removeForm();
        closePanel();
      }
    }
  });

  /* Right-click anywhere on page exits feedback mode and closes feedback panel */
  document.addEventListener(
    "contextmenu",
    function (e) {
      if (e.pointerType === "touch" || e.target.closest(".fb-image-dialog")) return;
      // Allow native contextmenu inside textarea and text inputs (for copy/paste)
      if (
        e.target &&
        (e.target.tagName === "TEXTAREA" ||
          (e.target.tagName === "INPUT" &&
            e.target.type !== "checkbox" &&
            e.target.type !== "button" &&
            e.target.type !== "submit"))
      ) {
        return;
      }

      var isPanelOpen = panel && panel.classList.contains("fb-open");
      if (mode || formEl || isPanelOpen) {
        e.preventDefault();
        e.stopPropagation();

        if (mode) setMode(false);
        else {
          removeForm();
          if (isPanelOpen) closePanel();
        }
      }
    },
    true
  );

  renderBadge();
  renderSaveButton();
  updateInspectGuide();
  pullFromServer(function () {
    refreshFeedbackView();
    log("init done", { entries: load().length, dirty: isDirty() });
  });
  })();
/* cache-bust: 20261104-english-enhanced */
