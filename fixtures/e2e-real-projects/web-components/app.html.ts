export const webComponentsApp = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Shadow 设置</title></head><body>
<main aria-label="Shadow 设置"><h1>Shadow 设置</h1><settings-panel></settings-panel></main><script>
class SettingsPanel extends HTMLElement{connectedCallback(){const root=this.attachShadow({mode:'open'});root.innerHTML='<button id="open">打开设置</button><span id="value"></span>';
root.querySelector('#open').onclick=()=>{const dialog=document.createElement('dialog');dialog.innerHTML='<label>名称<input aria-label="名称"></label><button id="save">保存</button>';root.append(dialog);dialog.showModal();dialog.querySelector('#save').onclick=()=>{const v=dialog.querySelector('input').value;localStorage.setItem('shadow-name',v);root.querySelector('#value').textContent=v;dialog.close()}};
root.querySelector('#value').textContent=localStorage.getItem('shadow-name')||''}}
customElements.define('settings-panel',SettingsPanel)</script></body></html>`
