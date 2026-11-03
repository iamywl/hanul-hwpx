use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::prelude::*;
use muda::{
    accelerator::Accelerator,
    Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tao::{
    dpi::LogicalSize,
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use wry::WebViewBuilder;

#[derive(Debug)]
enum UserEvent {
    Menu(muda::MenuEvent),
}

struct AppState {
    current_file_path: Option<PathBuf>,
}

fn get_base_root() -> PathBuf {
    // 1. App 번들 내부 Resources 확인
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            let res_dir = macos_dir.join("../Resources");
            if res_dir.join("vendor/studio").exists() {
                return res_dir;
            }
        }
    }
    // 2. 개발 환경: 프로젝트 루트
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir.join("../..");
    if project_root.join("vendor/studio").exists() {
        return project_root;
    }
    // 3. 현재 작업 디렉토리
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn make_editor_html(root: &Path, origin: &str) -> String {
    let index_path = root.join("vendor/studio/index.html");
    let mut source = fs::read_to_string(&index_path).unwrap_or_else(|_| {
        "<!DOCTYPE html><html><body><h1>에디터 파일을 찾을 수 없습니다.</h1></body></html>".to_string()
    });

    let base_uri = format!("{}/studio/", origin);
    let media_uri = format!("{}/media/", origin);

    // 불필요한 웹 전용 PWA / 아이콘 태그 제거 (콘솔 404 방지)
    for needle in &[
        "<link rel=\"icon\" href=\"/rhwp/favicon.ico\" />",
        "<link rel=\"apple-touch-icon\" href=\"/rhwp/icons/icon-256.png\" />",
        "<link rel=\"manifest\" href=\"/rhwp/manifest.webmanifest\">",
        "<script id=\"vite-plugin-pwa:register-sw\" src=\"/rhwp/registerSW.js\"></script>",
    ] {
        source = source.replace(needle, "");
    }

    // 진입점 교체
    if let Some(start) = source.find("src=\"/rhwp/assets/index") {
        if let Some(end) = source[start..].find(".js\"") {
            let target = &source[start..start + end + 4];
            source = source.replace(target, &format!("src=\"{}assets/hanul-runtime.js\"", base_uri));
        }
    }

    if let Some(start) = source.find("href=\"/rhwp/assets/index") {
        if let Some(end) = source[start..].find(".css\"") {
            let target = &source[start..start + end + 5];
            source = source.replace(target, &format!("href=\"{}assets/hanul-runtime.css\"", base_uri));
        }
    }

    source = source.replace("src=\"/rhwp/", &format!("src=\"{}", base_uri));
    source = source.replace("href=\"/rhwp/", &format!("href=\"{}", base_uri));

    let bridge_script = format!(
        r#"<script>
window.__hanulConfig = {{ base: "{}", media: "{}", development: false }};
window.__desktopReady = false;
window.__currentFileName = '새 문서.hwpx';
window.__hasBackingFile = false;
const __hanulFormatFromName = (n) => /\.hwp$/i.test(String(n || '')) ? 'hwp' : 'hwpx';
const __hanulSyncDocMeta = (name, hasFile) => {{
  window.__currentFileName = name || '새 문서.hwpx';
  window.__hasBackingFile = !!hasFile;
  document.title = window.__currentFileName + ' — 한울 (Hanul)';
}};
window.__hanulOpenFile = async function(fileName) {{
  try {{
    const r = await fetch('/api/file/raw');
    if (!r.ok) return;
    const buf = await r.arrayBuffer();
    const targetName = fileName || '문서.hwpx';
    __hanulSyncDocMeta(targetName, true);
    const send = (method, params = {{}}) => window.postMessage({{ type: 'request', id: crypto.randomUUID(), method, params }}, location.origin);
    send('load', {{ bytes: new Uint8Array(buf), name: targetName }});
  }} catch (e) {{
    console.error('문서 로드 실패:', e);
  }}
}};
window.__desktopApi = {{
  postMessage(m) {{
    window.__previewMessages = window.__previewMessages || [];
    window.__previewMessages.push(m);
    const send = (method, params = {{}}) => window.postMessage({{ type: 'request', id: crypto.randomUUID(), method, params }}, location.origin);
    const runSaveAs = () => {{
      fetch('/api/file/dialog-save', {{ method: 'POST' }})
        .then(r => r.json())
        .then(res => {{
          if (res.path) {{
            window.__pendingSavePath = res.path;
            send('export', {{ format: __hanulFormatFromName(res.path) }});
          }} else {{
            send('saveCancelled');
          }}
        }})
        .catch(e => send('saveFailed', {{ error: String(e) }}));
    }};
    if (m.type === 'ready') {{
      window.__desktopReady = true;
      fetch('/api/file/initial')
        .then(r => r.json())
        .then(async res => {{
          if (res.hasFile) {{
            try {{
              const rawResp = await fetch('/api/file/raw');
              if (rawResp.ok) {{
                const buffer = await rawResp.arrayBuffer();
                __hanulSyncDocMeta(res.name, true);
                send('load', {{ bytes: new Uint8Array(buffer), name: res.name }});
                return;
              }}
            }} catch (err) {{
              console.warn('[desktop] raw fetch 실패, fallback:', err);
            }}
            if (res.bytes) {{
              const binary = atob(res.bytes);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              __hanulSyncDocMeta(res.name, true);
              send('load', {{ bytes: bytes, name: res.name }});
              return;
            }}
          }}
          __hanulSyncDocMeta('새 문서.hwpx', false);
          send('load', {{ bytes: [], name: '새 문서.hwpx' }});
        }})
        .catch(() => {{
          __hanulSyncDocMeta('새 문서.hwpx', false);
          send('load', {{ bytes: [], name: '새 문서.hwpx' }});
        }});
    }} else if (m.type === 'new') {{
      fetch('/api/file/new', {{ method: 'POST' }}).catch(() => {{}});
      __hanulSyncDocMeta('새 문서.hwpx', false);
      send('load', {{ bytes: [], name: '새 문서.hwpx' }});
    }} else if (m.type === 'save') {{
      if (!window.__hasBackingFile) {{
        runSaveAs();
      }} else {{
        send('export', {{ format: __hanulFormatFromName(window.__currentFileName) }});
      }}
    }} else if (m.type === 'saveAs') {{
      runSaveAs();
    }} else if (m.type === 'open') {{
      fetch('/api/file/dialog-open', {{ method: 'POST' }})
        .then(r => r.json())
        .then(async res => {{
          if (res.success) {{
            try {{
              const rawResp = await fetch('/api/file/raw');
              if (rawResp.ok) {{
                const buffer = await rawResp.arrayBuffer();
                __hanulSyncDocMeta(res.name, true);
                send('load', {{ bytes: new Uint8Array(buffer), name: res.name }});
                return;
              }}
            }} catch (e) {{}}
            if (res.bytes && res.name) {{
              const binary = atob(res.bytes);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              __hanulSyncDocMeta(res.name, true);
              send('load', {{ bytes: bytes, name: res.name }});
            }}
          }}
        }});
    }} else if (m.type === 'response' && m.result && m.result.bytes) {{
      window.__lastExport = m.result;
      const savePath = window.__pendingSavePath || '';
      window.__pendingSavePath = null;
      fetch('/api/file/save', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/octet-stream', 'X-Save-Path': encodeURIComponent(savePath) }},
        body: new Uint8Array(m.result.bytes)
      }}).then(r => r.json()).then(res => {{
        if (res.success) {{
          const savedName = res.name || window.__currentFileName || '문서.hwpx';
          __hanulSyncDocMeta(savedName, true);
          send('saved', {{ name: savedName, version: m.result.version }});
        }} else if (res.needSaveAs) {{
          runSaveAs();
        }} else {{
          send('saveFailed', {{ error: res.error || '파일 저장에 실패했습니다.' }});
        }}
      }}).catch(e => send('saveFailed', {{ error: String(e) }}));
    }}
  }}
}};
window.__previewApi = window.__desktopApi;
</script>"#,
        base_uri, media_uri
    );

    let injection = format!(
        r#"<head>
<base href="{}">
{}
<script src="{}host.js"></script>
<link rel="stylesheet" href="{}host.css">"#,
        base_uri, bridge_script, media_uri, media_uri
    );

    source = source.replace("<head>", &injection);

    let compat_hidden_bar = r#"<div id="hanul-bar" style="display:none !important;" hidden aria-hidden="true"><span class="hanul-logo">H</span><strong>한울</strong><span id="hanul-name"></span><span class="hanul-tag"></span><span id="hanul-state"></span><button id="hanul-new"></button><button id="hanul-open"></button><button id="hanul-save-as"></button><button id="hanul-save"></button></div><div id="hanul-notice" role="status" hidden></div>"#;
    source.replace("<body>", &format!("<body>{}", compat_hidden_bar))
}

fn start_local_server(root: PathBuf, state: Arc<Mutex<AppState>>) -> (String, u16) {
    let server = Server::http("127.0.0.1:0").expect("로컬 서버를 바인딩할 수 없습니다.");
    let port = server.server_addr().to_ip().map(|addr| addr.port()).unwrap_or(4321);
    let origin = format!("http://127.0.0.1:{}", port);
    let server_origin = origin.clone();

    thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("/");

            // 1. 루트 및 index.html
            if path == "/" || path == "/index.html" {
                let html = make_editor_html(&root, &server_origin);
                let response = Response::from_string(html)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap())
                    .with_header(Header::from_bytes(&b"Cross-Origin-Opener-Policy"[..], &b"same-origin"[..]).unwrap())
                    .with_header(Header::from_bytes(&b"Cross-Origin-Embedder-Policy"[..], &b"require-corp"[..]).unwrap())
                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                let _ = request.respond(response);
                continue;
            }

            // 1.5. 초기 파일 요청 API
            if path == "/api/file/initial" && request.method() == &Method::Get {
                let current = {
                    let st = state.lock().unwrap();
                    st.current_file_path.clone()
                };

                if let Some(ref file_path) = current {
                    if let Ok(bytes) = fs::read(file_path) {
                        let name = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                        let base64_str = BASE64_STANDARD.encode(&bytes);
                        let json = serde_json::json!({
                            "hasFile": true,
                            "name": name,
                            "path": file_path.to_string_lossy(),
                            "bytes": base64_str,
                        });
                        let resp = Response::from_string(json.to_string())
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                        let _ = request.respond(resp);
                        continue;
                    }
                }

                let resp = Response::from_string(r#"{"hasFile":false}"#)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = request.respond(resp);
                continue;
            }

            // 1.6. 고속 바이너리 스트리밍 요청 API
            if path == "/api/file/raw" && request.method() == &Method::Get {
                let current = {
                    let st = state.lock().unwrap();
                    st.current_file_path.clone()
                };

                if let Some(ref file_path) = current {
                    if let Ok(bytes) = fs::read(file_path) {
                        let resp = Response::from_data(bytes)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/octet-stream"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                        let _ = request.respond(resp);
                        continue;
                    }
                }

                let resp = Response::from_string("File Not Found")
                    .with_status_code(StatusCode(404));
                let _ = request.respond(resp);
                continue;
            }

            // 2. 파일 열기 다이얼로그 API
            if path == "/api/file/dialog-open" && request.method() == &Method::Post {
                let file_opt = rfd::FileDialog::new()
                    .add_filter("한글 문서", &["hwpx", "hwp", "hml"])
                    .set_title("한글 문서 열기")
                    .pick_file();

                if let Some(file_path) = file_opt {
                    if let Ok(bytes) = fs::read(&file_path) {
                        let name = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                        let base64_str = BASE64_STANDARD.encode(&bytes);
                        
                        {
                            let mut st = state.lock().unwrap();
                            st.current_file_path = Some(file_path.clone());
                        }

                        let json = serde_json::json!({
                            "success": true,
                            "name": name,
                            "path": file_path.to_string_lossy(),
                            "bytes": base64_str,
                        });
                        let resp = Response::from_string(json.to_string())
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                        let _ = request.respond(resp);
                        continue;
                    }
                }
                let resp = Response::from_string(r#"{"success":false}"#);
                let _ = request.respond(resp);
                continue;
            }

            // 2.5. 새 문서 상태 초기화 API
            if path == "/api/file/new" && request.method() == &Method::Post {
                {
                    let mut st = state.lock().unwrap();
                    st.current_file_path = None;
                }
                let resp = Response::from_string(r#"{"success":true}"#)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = request.respond(resp);
                continue;
            }

            // 3. 다른 이름으로 저장 다이얼로그 API (.hwp 및 .hwpx 양방향 지원)
            if path == "/api/file/dialog-save" && request.method() == &Method::Post {
                let default_name = {
                    let st = state.lock().unwrap();
                    st.current_file_path
                        .as_ref()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "새 문서.hwpx".to_string())
                };
                let is_hwp = default_name.to_lowercase().ends_with(".hwp");
                let mut dlg = rfd::FileDialog::new()
                    .set_title("문서 저장")
                    .set_file_name(&default_name);
                if is_hwp {
                    dlg = dlg
                        .add_filter("한글 97-2024 문서 (HWP)", &["hwp"])
                        .add_filter("한글 표준 문서 (HWPX)", &["hwpx"]);
                } else {
                    dlg = dlg
                        .add_filter("한글 표준 문서 (HWPX)", &["hwpx"])
                        .add_filter("한글 97-2024 문서 (HWP)", &["hwp"]);
                }
                let file_opt = dlg.save_file();

                if let Some(file_path) = file_opt {
                    let json = serde_json::json!({
                        "success": true,
                        "path": file_path.to_string_lossy(),
                    });
                    let resp = Response::from_string(json.to_string())
                        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                    let _ = request.respond(resp);
                    continue;
                }
                let resp = Response::from_string(r#"{"success":false}"#)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = request.respond(resp);
                continue;
            }

            // 4. 저장 API
            if path == "/api/file/save" && request.method() == &Method::Post {
                let mut data = Vec::new();
                let _ = request.as_reader().read_to_end(&mut data);

                let custom_path = request.headers().iter()
                    .find(|h| h.field.equiv("X-Save-Path"))
                    .map(|h| urlencoding_decode(h.value.as_str()))
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from);

                let target_path = custom_path.or_else(|| {
                    let st = state.lock().unwrap();
                    st.current_file_path.clone()
                });

                if let Some(save_target) = target_path {
                    // Fail-safe 백업 생성
                    if save_target.exists() {
                        let backup_path = save_target.with_extension(format!("{}.hanul-backup", save_target.extension().unwrap_or_default().to_string_lossy()));
                        let _ = fs::copy(&save_target, backup_path);
                    }

                    match fs::write(&save_target, &data) {
                        Ok(()) => {
                            let name = save_target.file_name().unwrap_or_default().to_string_lossy().to_string();
                            {
                                let mut st = state.lock().unwrap();
                                st.current_file_path = Some(save_target.clone());
                            }

                            let json = serde_json::json!({
                                "success": true,
                                "name": name,
                                "path": save_target.to_string_lossy(),
                            });
                            let resp = Response::from_string(json.to_string())
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                            let _ = request.respond(resp);
                            continue;
                        }
                        Err(err) => {
                            let json = serde_json::json!({
                                "success": false,
                                "error": format!("파일 쓰기 실패: {}", err),
                            });
                            let resp = Response::from_string(json.to_string())
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                            let _ = request.respond(resp);
                            continue;
                        }
                    }
                }

                // 저장 경로가 지정되지 않은 경우 새 저장 다이얼로그 폴백
                let resp = Response::from_string(r#"{"success":false,"needSaveAs":true}"#)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = request.respond(resp);
                continue;
            }

            // 5. 정적 에셋 서빙
            let rel_path = if let Some(stripped) = path.strip_prefix("/studio/") {
                root.join("vendor/studio").join(stripped)
            } else if let Some(stripped) = path.strip_prefix("/media/") {
                root.join("media").join(stripped)
            } else {
                root.join("vendor/studio").join(path.trim_start_matches('/'))
            };

            if rel_path.exists() && rel_path.is_file() {
                if let Ok(bytes) = fs::read(&rel_path) {
                    let content_type = match rel_path.extension().and_then(|s| s.to_str()).unwrap_or("") {
                        "js" | "mjs" => "application/javascript",
                        "css" => "text/css",
                        "wasm" => "application/wasm",
                        "svg" => "image/svg+xml",
                        "png" => "image/png",
                        "ico" => "image/x-icon",
                        "woff2" => "font/woff2",
                        "woff" => "font/woff",
                        _ => "application/octet-stream",
                    };

                    let response = Response::from_data(bytes)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap())
                        .with_header(Header::from_bytes(&b"Cross-Origin-Opener-Policy"[..], &b"same-origin"[..]).unwrap())
                        .with_header(Header::from_bytes(&b"Cross-Origin-Embedder-Policy"[..], &b"require-corp"[..]).unwrap())
                        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                    let _ = request.respond(response);
                    continue;
                }
            }

            let _ = request.respond(Response::new_empty(StatusCode(404)));
        }
    });

    (origin, port)
}

fn urlencoding_decode(val: &str) -> String {
    let mut result = Vec::new();
    let bytes = val.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                result.push(b);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).to_string()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🚀 한울(Hanul) macOS 네이티브 데스크톱 앱을 시작합니다...");

    let root = get_base_root();
    println!("📁 에셋 루트 디렉토리: {}", root.display());

    let cli_file = std::env::args().nth(1)
        .map(PathBuf::from)
        .filter(|p| p.exists() && p.is_file());

    if let Some(ref p) = cli_file {
        println!("📄 초기 문서 로드: {}", p.display());
    }

    let initial_title = cli_file
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|n| format!("{} — 한울 (Hanul)", n.to_string_lossy()))
        .unwrap_or_else(|| "한울 (Hanul) · 한글 HWP/HWPX 에디터".to_string());

    let state = Arc::new(Mutex::new(AppState {
        current_file_path: cli_file,
    }));

    let (origin, port) = start_local_server(root.clone(), state.clone());
    println!("🌐 로컬 Rust 임베디드 코어 서버 가동: {} (port {})", origin, port);

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();

    let proxy = event_loop.create_proxy();
    muda::MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(UserEvent::Menu(event));
    }));

    // macOS 네이티브 메뉴 생성 (muda)
    let menu = Menu::new();

    let app_menu = Submenu::new("한울", true);
    app_menu.append_items(&[
        &PredefinedMenuItem::about(Some("한울 한글 에디터"), None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::services(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::hide(None),
        &PredefinedMenuItem::hide_others(None),
        &PredefinedMenuItem::show_all(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::quit(None),
    ])?;

    let file_menu = Submenu::new("파일", true);
    let new_acc: Option<Accelerator> = "CmdOrCtrl+N".parse().ok();
    let open_acc: Option<Accelerator> = "CmdOrCtrl+O".parse().ok();
    let save_acc: Option<Accelerator> = "CmdOrCtrl+S".parse().ok();
    let save_as_acc: Option<Accelerator> = "CmdOrCtrl+Shift+S".parse().ok();

    let new_item = MenuItem::new("새 문서", true, new_acc);
    let open_item = MenuItem::new("열기...", true, open_acc);
    let save_item = MenuItem::new("저장", true, save_acc);
    let save_as_item = MenuItem::new("다른 이름으로 저장...", true, save_as_acc);

    file_menu.append_items(&[
        &new_item,
        &open_item,
        &PredefinedMenuItem::separator(),
        &save_item,
        &save_as_item,
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::close_window(None),
    ])?;

    let edit_menu = Submenu::new("편집", true);
    let undo_acc: Option<Accelerator> = "CmdOrCtrl+Z".parse().ok();
    let redo_acc: Option<Accelerator> = "CmdOrCtrl+Shift+Z".parse().ok();
    let select_all_acc: Option<Accelerator> = "CmdOrCtrl+A".parse().ok();
    let find_acc: Option<Accelerator> = "CmdOrCtrl+F".parse().ok();

    let undo_item = MenuItem::new("실행 취소", true, undo_acc);
    let redo_item = MenuItem::new("다시 실행", true, redo_acc);
    let select_all_item = MenuItem::new("모두 선택", true, select_all_acc);
    let find_item = MenuItem::new("찾기...", true, find_acc);

    edit_menu.append_items(&[
        &undo_item,
        &redo_item,
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None),
        &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::separator(),
        &select_all_item,
        &PredefinedMenuItem::separator(),
        &find_item,
    ])?;

    menu.append_items(&[&app_menu, &file_menu, &edit_menu])?;

    #[cfg(target_os = "macos")]
    menu.init_for_nsapp();

    let window = WindowBuilder::new()
        .with_title(&initial_title)
        .with_inner_size(LogicalSize::new(1440.0, 960.0))
        .with_min_inner_size(LogicalSize::new(960.0, 640.0))
        .build(&event_loop)?;

    let builder = WebViewBuilder::new()
        .with_url(&origin)
        .with_devtools(true);

    let webview = builder.build(&window)?;

    let new_id = new_item.id().clone();
    let open_id = open_item.id().clone();
    let save_id = save_item.id().clone();
    let save_as_id = save_as_item.id().clone();
    let undo_id = undo_item.id().clone();
    let redo_id = redo_item.id().clone();
    let select_all_id = select_all_item.id().clone();
    let find_id = find_item.id().clone();

    let event_state = state.clone();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::NewEvents(StartCause::Init) => {
                println!("✨ 한울 macOS 네이티브 데스크톱 윈도우 초기화 완료.");
            }
            Event::Opened { urls } => {
                println!("📂 macOS Event::Opened 수신 (Finder 파일 열기): {:?}", urls);
                let mut opened_file: Option<PathBuf> = None;
                for u in urls {
                    if let Ok(p) = u.to_file_path() {
                        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                        if ext == "hwpx" || ext == "hwp" || ext == "hml" {
                            opened_file = Some(p);
                            break;
                        }
                    }
                }

                if let Some(file_path) = opened_file {
                    let file_name = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    println!("📄 Finder 파일 열기 대상: {} ({})", file_name, file_path.display());
                    window.set_title(&format!("{} — 한울 (Hanul)", file_name));
                    {
                        let mut st = event_state.lock().unwrap();
                        st.current_file_path = Some(file_path);
                    }
                    let script = format!(
                        r#"if (window.__desktopReady && typeof window.__hanulOpenFile === 'function') {{
                            window.__hanulOpenFile({});
                        }}"#,
                        serde_json::to_string(&file_name).unwrap_or_else(|_| "\"문서.hwpx\"".to_string())
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::DroppedFile(path),
                ..
            } => {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if ext == "hwpx" || ext == "hwp" || ext == "hml" {
                    let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    println!("📄 윈도우 드래그 앤 드롭 파일 수신: {}", path.display());
                    window.set_title(&format!("{} — 한울 (Hanul)", file_name));
                    {
                        let mut st = event_state.lock().unwrap();
                        st.current_file_path = Some(path);
                    }
                    let script = format!(
                        r#"if (window.__desktopReady && typeof window.__hanulOpenFile === 'function') {{
                            window.__hanulOpenFile({});
                        }}"#,
                        serde_json::to_string(&file_name).unwrap_or_else(|_| "\"문서.hwpx\"".to_string())
                    );
                    let _ = webview.evaluate_script(&script);
                }
            }
            Event::UserEvent(UserEvent::Menu(m_event)) => {
                if m_event.id == new_id {
                    window.set_title("새 문서.hwpx — 한울 (Hanul)");
                    let _ = webview.evaluate_script("window.__desktopApi.postMessage({ type: 'new' });");
                } else if m_event.id == open_id {
                    let _ = webview.evaluate_script("window.__desktopApi.postMessage({ type: 'open' });");
                } else if m_event.id == save_id {
                    let _ = webview.evaluate_script("window.__desktopApi.postMessage({ type: 'save' });");
                } else if m_event.id == save_as_id {
                    let _ = webview.evaluate_script("window.__desktopApi.postMessage({ type: 'saveAs' });");
                } else if m_event.id == undo_id {
                    let _ = webview.evaluate_script(
                        "(() => { const el = document.activeElement; const ih = window.__hanulEngine?.getInputHandler?.(); if (el && (el.tagName === 'INPUT' || (el.tagName === 'TEXTAREA' && el !== ih?.textarea))) { document.execCommand('undo'); } else { window.__hanulEngine?.command?.('edit:undo'); } })();"
                    );
                } else if m_event.id == redo_id {
                    let _ = webview.evaluate_script(
                        "(() => { const el = document.activeElement; const ih = window.__hanulEngine?.getInputHandler?.(); if (el && (el.tagName === 'INPUT' || (el.tagName === 'TEXTAREA' && el !== ih?.textarea))) { document.execCommand('redo'); } else { window.__hanulEngine?.command?.('edit:redo'); } })();"
                    );
                } else if m_event.id == select_all_id {
                    let _ = webview.evaluate_script(
                        "(() => { const el = document.activeElement; const ih = window.__hanulEngine?.getInputHandler?.(); if (el && (el.tagName === 'INPUT' || (el.tagName === 'TEXTAREA' && el !== ih?.textarea))) { el.select?.(); } else { window.__hanulEngine?.command?.('edit:select-all'); } })();"
                    );
                } else if m_event.id == find_id {
                    let _ = webview.evaluate_script("window.__hanulEngine?.command?.('edit:find');");
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => (),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_urlencoding_decode_korean_path() {
        let encoded = "%2FUsers%2Fywlee%2F%EA%B1%B0%EB%9E%98%EB%AA%85%EC%84%B8%EC%84%9C%20(2).hwp";
        assert_eq!(urlencoding_decode(encoded), "/Users/ywlee/거래명세서 (2).hwp");
    }

    #[test]
    fn test_make_editor_html_strips_pwa_and_preserves_format() {
        let root = get_base_root();
        let html = make_editor_html(&root, "http://127.0.0.1:4321");
        assert!(!html.contains("registerSW.js"), "dead PWA registerSW tag must be stripped");
        assert!(!html.contains("manifest.webmanifest"), "dead manifest tag must be stripped");
        assert!(html.contains("__hanulFormatFromName"), "format-preserving save helper must exist");
        assert!(html.contains("assets/hanul-runtime.js"), "patched runtime entry must be injected");
    }
}
