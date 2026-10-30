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
window.__desktopApi = {{
  postMessage(m) {{
    window.__previewMessages = window.__previewMessages || [];
    window.__previewMessages.push(m);
    const send = (method, params = {{}}) => window.postMessage({{ type: 'request', id: crypto.randomUUID(), method, params }}, location.origin);
    if (m.type === 'ready') {{
      fetch('/api/file/initial')
        .then(r => r.json())
        .then(res => {{
          if (res.hasFile && res.bytes) {{
            const binary = atob(res.bytes);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            send('load', {{ bytes: Array.from(bytes), name: res.name }});
          }} else {{
            send('load', {{ bytes: [], name: '새 문서.hwpx' }});
          }}
        }})
        .catch(() => send('load', {{ bytes: [], name: '새 문서.hwpx' }}));
    }} else if (m.type === 'new') {{
      send('load', {{ bytes: [], name: '새 문서.hwpx' }});
    }} else if (m.type === 'save') {{
      send('export', {{ format: 'hwpx' }});
    }} else if (m.type === 'saveAs') {{
      fetch('/api/file/dialog-save', {{ method: 'POST' }})
        .then(r => r.json())
        .then(res => {{
          if (res.path) {{
            window.__pendingSavePath = res.path;
            send('export', {{ format: 'hwpx' }});
          }}
        }});
    }} else if (m.type === 'open') {{
      fetch('/api/file/dialog-open', {{ method: 'POST' }})
        .then(r => r.json())
        .then(res => {{
          if (res.bytes && res.name) {{
            const binary = atob(res.bytes);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            send('load', {{ bytes: Array.from(bytes), name: res.name }});
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
          send('saved', {{ name: res.name || '문서.hwpx', version: m.result.version }});
        }}
      }}).catch(e => console.error('저장 실패:', e));
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

            // 3. 다른 이름으로 저장 다이얼로그 API
            if path == "/api/file/dialog-save" && request.method() == &Method::Post {
                let file_opt = rfd::FileDialog::new()
                    .add_filter("한글 표준 문서 (HWPX)", &["hwpx"])
                    .set_title("문서 저장")
                    .save_file();

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
                let resp = Response::from_string(r#"{"success":false}"#);
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

                    if fs::write(&save_target, &data).is_ok() {
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
                }

                // 저장 경로가 지정되지 않은 경우 새 저장 다이얼로그 폴백
                let resp = Response::from_string(r#"{"success":false,"needSaveAs":true}"#);
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
    edit_menu.append_items(&[
        &PredefinedMenuItem::undo(None),
        &PredefinedMenuItem::redo(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None),
        &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::select_all(None),
    ])?;

    menu.append_items(&[&app_menu, &file_menu, &edit_menu])?;

    #[cfg(target_os = "macos")]
    menu.init_for_nsapp();

    let window = WindowBuilder::new()
        .with_title("한울 (Hanul) · 한글 HWP/HWPX 에디터")
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

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::NewEvents(StartCause::Init) => {
                println!("✨ 한울 macOS 네이티브 데스크톱 윈도우 초기화 완료.");
            }
            Event::UserEvent(UserEvent::Menu(m_event)) => {
                if m_event.id == new_id {
                    let _ = webview.evaluate_script("window.__desktopApi.postMessage({ type: 'new' });");
                } else if m_event.id == open_id {
                    let _ = webview.evaluate_script("window.__desktopApi.postMessage({ type: 'open' });");
                } else if m_event.id == save_id {
                    let _ = webview.evaluate_script("window.__desktopApi.postMessage({ type: 'save' });");
                } else if m_event.id == save_as_id {
                    let _ = webview.evaluate_script("window.__desktopApi.postMessage({ type: 'saveAs' });");
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
