const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const OPENCLAW_MODELS_PATH = path.join(
  process.env.HOME || '/home/liujie',
  '.openclaw/agents/main/agent/models.json'
);

function getApiKey(keyPath) {
  const configKey = vscode.workspace.getConfiguration('aiCopilot').get(keyPath);
  if (configKey) return configKey;
  try {
    const data = JSON.parse(fs.readFileSync(OPENCLAW_MODELS_PATH, 'utf8'));
    const key = data?.providers?.deepseek?.apiKey;
    if (key) return key;
  } catch {}
  return '';
}

function activate(context) {
  console.log('AI Copilot activated');

  context.subscriptions.push(
    vscode.commands.registerCommand('aiCopilot.explain', () => handleCodeAction('explain'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiCopilot.optimize', () => handleCodeAction('optimize'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiCopilot.review', () => handleCodeAction('review'))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiCopilot.chat', () =>
      vscode.commands.executeCommand('workbench.view.extension.ai-copilot')
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiCopilot.complete', () => {
      vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    })
  );

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new AIInlineProvider(context)
    )
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aiCopilot.chat', new ChatPanelProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

// ── 右键菜单 ──

async function handleCodeAction(action) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return vscode.window.showWarningMessage('请先选中一段代码');
  const selection = editor.selection;
  if (selection.isEmpty) return vscode.window.showWarningMessage('请先选中一段代码');

  const code = editor.document.getText(selection);
  const language = editor.document.languageId;
  const fileName = path.basename(editor.document.uri.fsPath);

  const prompts = {
    explain: '请用中文解释以下 ' + language + ' 代码的功能和关键逻辑（文件：' + fileName + '）：\n```' + language + '\n' + code + '\n```',
    optimize: '请优化以下 ' + language + ' 代码，指出可改进的地方并给出优化后的版本（文件：' + fileName + '）：\n```' + language + '\n' + code + '\n```',
    review: '请审查以下 ' + language + ' 代码（文件：' + fileName + '），找出 bug、安全隐患和可改进的地方：\n```' + language + '\n' + code + '\n```',
  };

  const config = vscode.workspace.getConfiguration('aiCopilot');
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'AI Copilot 思考中...' },
    async () => {
      try {
        const result = await callDeepSeek(config, prompts[action]);
        const panel = vscode.window.createOutputChannel('AI Copilot');
        panel.clear();
        panel.appendLine(result);
        panel.show();
      } catch (err) {
        vscode.window.showErrorMessage('AI Copilot 出错: ' + err.message);
      }
    }
  );
}

// ── API 调用 ──

async function callDeepSeek(config, prompt, onStream, history) {
  const apiKey = getApiKey('apiKey');
  if (!apiKey) throw new Error('无法获取 DeepSeek API Key');

  const messages = [
    { role: 'system', content: '你是一个直接高效的编程助手。用户让你写代码就直接写，不要问问题。代码用 markdown 代码块标语言。如果用户说"写到文件"或"创建文件"，在代码块前加一行 文件名: xxx.xx 来指定文件名。只干不废话。' },
  ];

  if (history && history.length > 0) {
    const recent = history.slice(-20);
    for (const m of recent) {
      if (m.role && m.content) {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }

  messages.push({ role: 'user', content: prompt });

  const body = {
    model: config.get('model'),
    messages: messages,
    stream: !!onStream,
  };

  const response = await fetch(config.get('apiUrl'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('API 请求失败 (' + response.status + '): ' + err);
  }

  if (onStream) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const text = chunk.choices?.[0]?.delta?.content || '';
          if (text) onStream(text);
        } catch {}
      }
    }
    return;
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callQwenVL(text, imageBase64, onStream) {
  const apiKey = getApiKey('qwenApiKey');
  if (!apiKey) throw new Error('请先配置 aiCopilot.qwenApiKey');

  const messages = [
    { role: 'system', content: '你是一个直接高效的编程助手。看图回答问题，简洁准确，不要啰嗦。' },
  ];

  const userContent = [];
  if (imageBase64) {
    userContent.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } });
  }
  userContent.push({ type: 'text', text: text });
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: 'qwen-vl-plus',
    messages: messages,
    stream: !!onStream,
  };

  const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Qwen-VL 请求失败 (' + response.status + '): ' + err);
  }

  if (onStream) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const text = chunk.choices?.[0]?.delta?.content || '';
          if (text) onStream(text);
        } catch {}
      }
    }
    return;
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ── 内联自动补全 ──

class AIInlineProvider {
  constructor(context) {
    this._context = context;
  }

  async provideInlineCompletionItems(document, position) {
    const line = document.lineAt(position.line);
    const linePrefix = line.text.substring(0, position.character);
    const language = document.languageId;
    const fileName = path.basename(document.uri.fsPath);

    const startLine = Math.max(0, position.line - 10);
    const contextCode = document.getText(
      new vscode.Range(startLine, 0, position.line + 1, position.character)
    );

    const lastChar = linePrefix.trimEnd().slice(-1);
    const triggerChars = ['{', '(', '[', ':', ',', '=', '->', '.'];
    const isTriggered = triggerChars.includes(lastChar) || linePrefix.trim().length < 3;
    if (!isTriggered && position.character > 2) return [];

    const config = vscode.workspace.getConfiguration('aiCopilot');

    try {
      const suggestion = await callDeepSeek(config,
        '你正在编辑 ' + language + ' 文件 ' + fileName + '。\n' +
        '根据上下文，提供当前位置（光标在行末）最可能的后续代码。\n\n' +
        '当前代码：\n```' + language + '\n' + contextCode + '\n```\n\n' +
        '注意：只返回后续代码本身，不要任何解释。最多返回5行。'
      );

      let cleanSuggestion = suggestion
        .replace(/\n```/g, '')
        .replace(/```/g, '')
        .replace(/^\n+/, '')
        .replace(/\n{2,}/g, '\n')
        .trim();

      if (!cleanSuggestion) return [];

      return [new vscode.InlineCompletionItem(cleanSuggestion)];
    } catch {
      return [];
    }
  }
}

// ── 侧边栏对话面板 ──

class ChatPanelProvider {
  constructor(context) {
    this._context = context;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    const savedHistory = this._context.workspaceState.get('aiCopilot.chatHistory', []);
    webviewView.webview.html = this._getHtml(savedHistory);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'sendMessage':
          await this._handleSend(msg.text, msg.image);
          break;
        case 'applyCode':
          await this._handleApplyCode(msg.code, msg.language);
          break;
        case 'createFile':
          await this._handleCreateFile(msg.code, msg.language, msg.filename);
          break;
        case 'saveHistory':
          await this._context.workspaceState.update('aiCopilot.chatHistory', msg.history);
          break;
        case 'clearHistory':
          await this._context.workspaceState.update('aiCopilot.chatHistory', []);
          break;
      }
    });
  }

  async _handleSend(text, imageBase64) {
    const shouldSave = /写入文件|写进|创建文件|保存|在文件里|新建文件|写到文件|文件里|写出来|存到|保存到|写到/i.test(text);

    let prompt = text;

    if (!imageBase64) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const fullCode = editor.document.getText();
        const lang = editor.document.languageId;
        const fileName = path.basename(editor.document.uri.fsPath);
        prompt += '\n\n当前文件 (' + fileName + '):\n```' + lang + '\n' + fullCode + '\n```';
      }
    }

    this._view.webview.postMessage({ type: 'startStream' });
    let fullContent = '';

    try {
      if (imageBase64) {
        await callQwenVL(text, imageBase64, (chunk) => {
          fullContent += chunk;
          this._view.webview.postMessage({ type: 'streamChunk', chunk: chunk });
        });
      } else {
        const chatHistory = this._context.workspaceState.get('aiCopilot.chatHistory', []);
        await callDeepSeek(vscode.workspace.getConfiguration('aiCopilot'), prompt, (chunk) => {
          fullContent += chunk;
          this._view.webview.postMessage({ type: 'streamChunk', chunk: chunk });
        }, chatHistory);
      }

      this._view.webview.postMessage({ type: 'endStream', content: fullContent });

      if (shouldSave && !imageBase64) {
        this._autoCreateFile(fullContent);
      }
    } catch (err) {
      this._view.webview.postMessage({ type: 'endStream', content: '错误: ' + err.message });
    }
  }

  _autoCreateFile(content) {
    const match = content.match(/```(\w*)\n([\s\S]*?)```/);
    if (!match) {
      vscode.window.showErrorMessage('没有找到代码块，无法创建文件');
      return;
    }

    const language = match[1] || '';
    const code = match[2];

    const ext = {
      python: '.py', javascript: '.js', typescript: '.ts', html: '.html',
      css: '.css', json: '.json', markdown: '.md', shell: '.sh',
      bash: '.sh', java: '.java', go: '.go', rust: '.rs',
      ruby: '.rb', php: '.php', c: '.c'
    } [language] || '.txt';

    const nameMatch = content.match(/文件名[：:]\s*([^\s]+)/);
    let fileName = nameMatch ? nameMatch[1] : ('code_' + Date.now());
    if (!fileName.endsWith(ext)) fileName += ext;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      vscode.window.showErrorMessage('请先打开一个文件夹');
      return;
    }

    const fileUri = vscode.Uri.joinPath(folders[0].uri, fileName);
    vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf8')).then(function() {
      vscode.window.showInformationMessage('✅ 已创建: ' + fileName);
      return vscode.workspace.openTextDocument(fileUri);
    }).then(function(doc) {
      vscode.window.showTextDocument(doc);
    }, function(err) {
      vscode.window.showErrorMessage('创建失败: ' + err.message);
    });
  }

  async _handleApplyCode(code, language) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit(function(editBuilder) {
        editBuilder.insert(editor.selection.active, code);
      });
      vscode.window.showInformationMessage('代码已插入');
    } else {
      const doc = await vscode.workspace.openTextDocument({ content: code, language: language });
      vscode.window.showTextDocument(doc);
    }
  }

  async _handleCreateFile(code, language, filename) {
    const extMap = {
      python: '.py', javascript: '.js', typescript: '.ts', html: '.html',
      css: '.css', json: '.json', markdown: '.md', shell: '.sh',
      bash: '.sh', java: '.java', go: '.go', rust: '.rs',
      c: '.c', 'c++': '.cpp', 'c#': '.cs', ruby: '.rb', php: '.php'
    };
    const ext = extMap[language] || '.txt';
    const name = (filename || 'untitled') + (filename.endsWith(ext) ? '' : ext);

    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { vscode.window.showErrorMessage('请先打开文件夹'); return; }

    const fileUri = vscode.Uri.joinPath(folders[0].uri, name);
    try {
      await vscode.workspace.fs.stat(fileUri);
      const overwrite = await vscode.window.showQuickPick(['是', '否'], { placeHolder: '文件 ' + name + ' 已存在，覆盖？' });
      if (overwrite !== '是') return;
    } catch {}

    vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf8')).then(function() {
      vscode.window.showInformationMessage('已创建: ' + name);
      return vscode.workspace.openTextDocument(fileUri);
    }).then(function(doc) {
      vscode.window.showTextDocument(doc);
    });
  }

  _getHtml(savedHistory) {
    var json = JSON.stringify(savedHistory);
    var h = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<style>' +
      'body{background:#1e1e1e;color:#ccc;font:13px/1.6 sans-serif;padding:10px 10px 80px;margin:0}' +
      '.msg{padding:8px 12px;margin:8px 0;border-radius:6px;white-space:pre-wrap;word-break:break-word}' +
      '.user{background:#333;margin-left:20%}' +
      '.assistant{background:#252526}' +
      '#inp{width:100%;padding:10px;border:1px solid #555;border-radius:4px;background:#333;color:#ddd;font:13px sans-serif;box-sizing:border-box}' +
      '#sendbtn{width:100%;padding:8px;margin-top:6px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px}' +
      '#footer{position:fixed;bottom:0;left:0;right:0;padding:10px;background:#1e1e1e;border-top:1px solid #333}' +
      '</style></head><body>' +
      '<div id="msg"><center style="color:#666;margin:20px">AI Copilot</center></div>' +
      '<div id="footer"><textarea id="inp" rows="2" placeholder="问问题... (Enter 发送)"></textarea><button id="sendbtn">发送</button></div>' +
      '<script>' +
      'var D=' + json + ';' +
      'var A=acquireVsCodeApi();' +
      'var M=document.getElementById("msg");' +
      'var I=document.getElementById("inp");' +
      'var B=document.getElementById("sendbtn");' +
      'function add(r,c){var d=document.createElement("div");d.className="msg "+r;d.textContent=c||"";M.appendChild(d);M.scrollTop=M.scrollHeight}' +
      'for(var i=0;i<D.length;i++){add(D[i].role,D[i].content)}' +
      'function send(){var t=I.value.trim();if(!t)return;add("user",t);D.push({role:"user",content:t});A.postMessage({type:"saveHistory",history:D.slice(-100)});A.postMessage({type:"sendMessage",text:t,image:null});I.value=""}' +
      'I.onkeydown=function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}};' +
      'B.onclick=send;' +
      'var S=null;' +
      'window.addEventListener("message",function(e){var d=e.data;if(d.type==="startStream"){var x=document.createElement("div");x.className="msg assistant";M.appendChild(x);S=x;D.push({role:"assistant",content:""})}if(d.type==="streamChunk"&&S){S.textContent+=d.chunk;M.scrollTop=M.scrollHeight}if(d.type==="endStream"){if(S&&S.parentNode)S.parentNode.removeChild(S);S=null;D[D.length-1].content=d.content;add("assistant",d.content);A.postMessage({type:"saveHistory",history:D.slice(-100)})}})' +
      '</script></body></html>';
    return h;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
