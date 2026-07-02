import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, existsSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(),"orch-fc-"));
const t = new StdioClientTransport({ command:"node", args:[join(process.cwd(),"dist/server.js")], env:{...process.env, ORCH_HOME:home, ORCH_AUTO_UPDATE:"false"}});
const c = new Client({name:"fc",version:"1"},{capabilities:{}}); await c.connect(t);
const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a});let d;try{d=JSON.parse(r.content[0].text)}catch{d={raw:r.content[0].text}}return{isError:!!r.isError,data:d}};
let fail=0; const ck=(cond,l,x)=>{console.log(`${cond?"✔":"✘"} ${l}`,x!==undefined?JSON.stringify(x):"");if(!cond)fail++;};

const plan = await call("cluster_plan",{goal:"FC",repo_path:home,clusters:[{id:"C1",name:"n",goal:"g",tasks:["a"],acceptance:["x"],model_policy:{class:"strong",effort:"xhigh",sandbox:"read-only",model:"gpt-5.5"},review_strategy:{checks:["npm_test"]}}]});
ck(plan.data.ok,"cluster_plan mit model_policy.model+xhigh");
await call("hypotheses",{plan_id:plan.data.plan_id,action:"add",text:"Annahme A",evidence:"Quelle"});

const snap = await call("plan_snapshot",{plan_id:plan.data.plan_id,format:"toon"});
ck(snap.data.ok && /plan:/.test(snap.data.content) && /clusters/.test(snap.data.content) && /hypotheses/.test(snap.data.content),"plan_snapshot TOON enthält plan/clusters/hypotheses");
ck(existsSync(snap.data.path),"Snapshot-Datei geschrieben",snap.data.path);
console.log("--- TOON-Auszug ---\n"+snap.data.content.split("\n").slice(0,10).join("\n"));

const upd = await call("codex_update",{action:"check",channel:"latest"});
ck(upd.data.ok && upd.data.installed && upd.data.latest,"codex_update check",{installed:upd.data.installed,latest:upd.data.latest,updateAvailable:upd.data.updateAvailable});
const updA = await call("codex_update",{action:"check",channel:"alpha"});
ck(updA.data.ok && updA.data.latest,"codex_update alpha-Kanal",{latest:updA.data.latest});

console.log(fail===0?"\n=== FEATURECHECK BESTANDEN ===":`\n=== ${fail} FEHLER ===`);
await c.close(); process.exit(fail?1:0);
