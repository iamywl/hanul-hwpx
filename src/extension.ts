import * as vscode from 'vscode';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { editorHtml } from './html';
import { atomicSave, digest, formatOf, validateBytes, type Format } from './storage';

const viewType = 'hanul.editor';
class HanulDocument implements vscode.CustomDocument {
  readonly disposed = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposed.event;
  panel?: vscode.WebviewPanel;
  version = 0;
  savedVersion = 0;
  ready = false;
  pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly uri: vscode.Uri, public bytes: Uint8Array, public originalHash: string | null, readonly restored: boolean) {}
  dispose() {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('문서 편집기가 닫혔습니다.')); }
    this.pending.clear(); this.disposed.fire(); this.disposed.dispose();
  }
}
class HanulProvider implements vscode.CustomEditorProvider<HanulDocument> {
  readonly documents = new Map<string, HanulDocument>();
  private readonly emitter = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<HanulDocument>>();
  readonly onDidChangeCustomDocument = this.emitter.event;
  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) { context.subscriptions.push(this.emitter); }
  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<HanulDocument> {
    const original = uri.scheme === 'untitled' ? new Uint8Array() : await vscode.workspace.fs.readFile(uri);
    const bytes = openContext.backupId ? await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId)) : openContext.untitledDocumentData ?? original;
    if (bytes.length) validateBytes(bytes, formatOf(uri.path));
    const document = new HanulDocument(uri, bytes, original.length ? digest(original) : null, !!openContext.backupId);
    this.documents.set(uri.toString(), document);
    document.onDidDispose(() => this.documents.delete(uri.toString()));
    return document;
  }
  async resolveCustomEditor(document: HanulDocument, panel: vscode.WebviewPanel): Promise<void> {
    document.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'vendor'), vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const receiver = panel.webview.onDidReceiveMessage(async (message: any) => {
      try {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'response') {
          const pending = document.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer); document.pending.delete(message.id);
          message.error ? pending.reject(Error(String(message.error))) : pending.resolve(message.result);
        } else if (message.type === 'ready') {
          document.ready = true;
          await this.request(document, 'load', { bytes: Array.from(document.bytes), name: basename(document.uri.path), restored: document.restored });
          if (document.restored) { document.version++; this.emitter.fire({ document }); }
        } else if (message.type === 'changed' && Number.isSafeInteger(message.version)) {
          document.version = message.version;
          this.emitter.fire({ document });
        } else if (message.type === 'save' || message.type === 'saveAs') {
          panel.reveal(undefined, true);
          await vscode.commands.executeCommand(message.type === 'saveAs' || document.uri.scheme === 'untitled' ? 'workbench.action.files.saveAs' : 'workbench.action.files.save');
        } else if (message.type === 'new') {
          await vscode.commands.executeCommand('hanul.new');
        } else if (message.type === 'open') {
          await vscode.commands.executeCommand('hanul.open');
        } else if (message.type === 'error') {
          this.log.appendLine(String(message.error));
          void vscode.window.showErrorMessage(`한울: ${message.error}`);
        }
      } catch (error) { this.report(error); }
    });
    panel.onDidDispose(() => { receiver.dispose(); document.panel = undefined; document.ready = false; for (const p of document.pending.values()) { clearTimeout(p.timer); p.reject(Error('편집기가 닫혔습니다.')); } document.pending.clear(); });
    panel.webview.html = editorHtml(panel.webview, this.context.extensionUri, this.context.extensionMode !== vscode.ExtensionMode.Production);
  }
  private report(error: unknown) { this.log.appendLine(String(error)); void vscode.window.showErrorMessage(`한울: ${error instanceof Error ? error.message : String(error)}`); }
  private async request(document: HanulDocument, method: string, params: unknown = {}): Promise<any> {
    if (!document.panel || !document.ready) throw Error('문서 편집기가 아직 준비되지 않았습니다.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { document.pending.delete(id); reject(Error(`${method}: 편집기 응답 시간이 초과되었습니다.`)); }, 60000);
      document.pending.set(id, { resolve, reject, timer });
      void document.panel!.webview.postMessage({ type: 'request', id, method, params }).then(ok => {
        if (!ok) { clearTimeout(timer); document.pending.delete(id); reject(Error('편집기에 요청을 전달하지 못했습니다.')); }
      });
    });
  }
  private async snapshot(document: HanulDocument, format: Format, token: vscode.CancellationToken): Promise<{ bytes: Uint8Array; version: number }> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (document.version === document.savedVersion && document.bytes.length && format === formatOf(document.uri.path)) return { bytes: document.bytes, version: document.version };
    const result = await this.request(document, 'export', { format });
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (!Array.isArray(result.bytes) || !Number.isSafeInteger(result.version) || result.bytes.some((n: unknown) => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 255)) throw Error('편집기가 유효한 문서 데이터를 반환하지 않았습니다.');
    const bytes = new Uint8Array(result.bytes);
    validateBytes(bytes, format);
    return { bytes, version: result.version };
  }
  async saveCustomDocument(document: HanulDocument, token: vscode.CancellationToken): Promise<void> {
    if (document.uri.scheme === 'untitled') throw Error('새 문서를 다른 이름으로 저장해 주세요.');
    await this.save(document, document.uri, token);
  }
  async saveCustomDocumentAs(document: HanulDocument, destination: vscode.Uri, token: vscode.CancellationToken): Promise<void> { await this.save(document, destination, token); }
  private async save(document: HanulDocument, destination: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
    if (destination.scheme !== 'file') throw Error('이 시제품은 로컬 파일 저장을 지원합니다.');
    const format = formatOf(destination.path);
    try {
      const snapshot = await this.snapshot(document, format, token);
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const same = destination.toString() === document.uri.toString();
      await atomicSave(destination.fsPath, snapshot.bytes, same ? document.originalHash : undefined, vscode.workspace.getConfiguration('hanul').get('backupBeforeSave', true));
      if (same) { document.bytes = snapshot.bytes; document.originalHash = digest(snapshot.bytes); document.savedVersion = snapshot.version; }
      await this.request(document, 'saved', { name: basename(destination.path), version: snapshot.version });
      if (document.version > snapshot.version) setTimeout(() => this.emitter.fire({ document }), 0);
      this.log.appendLine(`Saved ${destination.fsPath} (${snapshot.bytes.length} bytes)`);
    } catch (error) {
      if (document.ready) void this.request(document, 'saveFailed', { error: error instanceof Error ? error.message : String(error) }).catch(() => {});
      throw error;
    }
  }
  async revertCustomDocument(document: HanulDocument): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    validateBytes(bytes, formatOf(document.uri.path));
    await this.request(document, 'load', { bytes: Array.from(bytes), name: basename(document.uri.path) });
    document.bytes = bytes; document.originalHash = digest(bytes); document.version = 0; document.savedVersion = 0;
  }
  async backupCustomDocument(document: HanulDocument, context: vscode.CustomDocumentBackupContext, token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    const { bytes } = await this.snapshot(document, formatOf(document.uri.path), token);
    await vscode.workspace.fs.writeFile(context.destination, bytes);
    return { id: context.destination.toString(), delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch {} } };
  }
}
export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('한울 한글 편집기');
  context.subscriptions.push(log);
  const provider = new HanulProvider(context, log);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewType, provider, { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }));
  let sequence = 0;
  const open = async (uri: vscode.Uri) => vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  context.subscriptions.push(vscode.commands.registerCommand('hanul.new', async () => open(vscode.Uri.parse(`untitled:새 문서-${++sequence}.hwpx`))));
  context.subscriptions.push(vscode.commands.registerCommand('hanul.open', async () => {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { '한글 문서': ['hwp', 'hwpx'] } });
    if (files?.[0]) await open(files[0]);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('hanul.demo', async () => {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('한울 예제.hwpx'), filters: { HWPX: ['hwpx'] } });
    if (!target) return;
    const bytes = await readFile(vscode.Uri.joinPath(context.extensionUri, 'templates/report.hwpx').fsPath);
    validateBytes(bytes, 'hwpx');
    await vscode.workspace.fs.writeFile(target, bytes);
    await open(target);
  }));
  // Development diagnostics are used by the VS Code integration suite, never exposed in a packaged build.
  if (context.extensionMode !== vscode.ExtensionMode.Production) return { provider };
}
