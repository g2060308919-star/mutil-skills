export function reactLikeApp(defect: 'none' | 'permission-leak' | 'reload-loss'): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>运营工作台</title>
<style>body{font:14px system-ui;margin:24px}.overlay{position:fixed;inset:15% 20%;background:white;border:1px solid;padding:20px;box-shadow:0 5px 30px #555}.row{display:flex;gap:8px}.virtual{height:100px;overflow:auto}.hidden{display:none}</style></head>
<body><main aria-label="运营工作台"><h1>运营工作台</h1><label>角色<select data-testid="role"><option value="admin">管理员</option><option value="user">普通用户</option></select></label>
<section><input data-testid="query" placeholder="查询"><button data-testid="sort">排序</button><button data-testid="page">下一页</button><div data-testid="table"></div></section>
<section><select data-testid="type"><option value="personal">个人</option><option value="company">企业</option></select><input data-testid="tax" class="hidden" placeholder="税号"><span data-testid="validation"></span></section>
<section class="row"><input data-testid="title" placeholder="标题"><button data-testid="save">保存</button><button data-testid="review">审核</button><button data-testid="open">打开详情</button><button data-testid="download">下载</button></section>
<div data-testid="status">草稿</div><div class="virtual" data-testid="virtual"></div><div data-testid="portal"></div></main>
<script>
const defect=${JSON.stringify(defect)}; const q=(id)=>document.querySelector('[data-testid="'+id+'"]');
let items=['Gamma','Alpha','Beta','Delta']; const render=()=>{ q('table').textContent=items.join('|'); q('virtual').innerHTML=items.map(x=>'<div>'+x+'</div>').join('') };
render(); q('sort').onclick=()=>{items.sort();render()}; q('page').onclick=()=>{items=items.slice(2);render()}; q('query').oninput=e=>{q('table').textContent=items.filter(x=>x.toLowerCase().includes(e.target.value.toLowerCase())).join('|')};
q('role').onchange=e=>{q('review').classList.toggle('hidden',e.target.value==='user'&&defect!=='permission-leak')};
q('type').onchange=e=>q('tax').classList.toggle('hidden',e.target.value!=='company'); q('tax').oninput=e=>q('validation').textContent=e.target.value.length<4?'税号无效':'';
q('save').onclick=()=>{const value=q('title').value; if(value){localStorage.setItem('real-title',value);q('status').textContent='已保存'}};
q('review').onclick=()=>{q('status').textContent='处理中';setTimeout(()=>{q('status').textContent='已通过';localStorage.setItem('real-status','已通过')},80)};
q('open').onclick=()=>{q('portal').innerHTML='<div class="overlay" role="dialog" aria-label="订单详情"><button data-testid="close">关闭</button><p>详情加载完成</p></div>';q('close').onclick=()=>q('portal').innerHTML=''};
q('download').onclick=()=>{const a=document.createElement('a');a.download='orders.csv';a.href='data:text/csv;charset=utf-8,id,title%0A1,alpha';a.click()};
if(defect!=='reload-loss'){q('title').value=localStorage.getItem('real-title')||'';q('status').textContent=localStorage.getItem('real-status')||'草稿'}
</script></body></html>`
}
