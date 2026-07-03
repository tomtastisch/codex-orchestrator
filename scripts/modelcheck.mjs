import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(),"orch-mc-"));
// Gate aus: dieser Check prüft ausschließlich Modell/Effort-Validierung, nicht das Hypothesen-Gate.
const t = new StdioClientTransport({ command:"node", args:[join(process.cwd(),"dist/server.js")], env:{...process.env, ORCH_HOME:home, ORCH_REQUIRE_HYPOTHESIS:"false"}});
const c = new Client({name:"mc",version:"1"},{capabilities:{}}); await c.connect(t);
const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a});return {isError:!!r.isError,data:JSON.parse(r.content[0].text)};};
let fail=0; const ck=(cond,l,x)=>{console.log(`${cond?"✔":"✘"} ${l}`,x?JSON.stringify(x):"");if(!cond)fail++;};
const ml = await call("models_list",{});
ck(ml.data.available_models?.map(m=>m.model).join(",")==="gpt-5.5,gpt-5.4,gpt-5.4-mini","models_list: reale Modelle",ml.data.available_models?.map(m=>m.model));
ck(JSON.stringify(ml.data.effort_ladder)===JSON.stringify(["low","medium","high","xhigh"]),"effort_ladder inkl. xhigh",ml.data.effort_ladder);
// invalide Kombi: gpt-5.4-mini + xhigh -> muss abgelehnt werden, OHNE Codex zu starten
const bad = await call("task_start",{repo_path:home,instructions:"x",sandbox:"read-only",model:"gpt-5.4-mini",effort:"xhigh",wait_for:"started"});
ck(bad.isError===true && /nicht zulässig/.test(bad.data.error),"gpt-5.4-mini+xhigh abgelehnt",bad.data.error);
// gültige Kombi gpt-5.5 + xhigh -> akzeptiert (wait_for started, kein Codex-Aufruf blockierend)
const good = await call("task_start",{repo_path:home,instructions:"x",sandbox:"read-only",model:"gpt-5.5",effort:"xhigh",wait_for:"started"});
ck(good.data.ok===true && good.data.model==="gpt-5.5" && good.data.effort==="xhigh","gpt-5.5+xhigh akzeptiert",{model:good.data.model,effort:good.data.effort});
// unbekanntes Modell -> erlaubt mit Hinweis
const unk = await call("task_start",{repo_path:home,instructions:"x",sandbox:"read-only",model:"codex-experimental",effort:"medium",wait_for:"started"});
ck(unk.data.ok===true && /nicht im Katalog/.test(unk.data.note||""),"unbekanntes Modell: erlaubt mit Hinweis",unk.data.note);
console.log(fail===0?"\n=== MODELCHECK BESTANDEN ===":`\n=== ${fail} FEHLER ===`);
await c.close(); process.exit(fail?1:0);
