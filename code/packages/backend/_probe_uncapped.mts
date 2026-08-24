import fs from "node:fs"; import path from "node:path";
import { HARD_SKIP } from "./src/shared/scan-filters.js";
const root = process.env.ROOT!; const threshold = 104857600;
let dirs=0, files=0, big=0, statCalls=0; const t=Date.now();
const stack=[root];
while(stack.length){ const dir=stack.pop()!; dirs++;
  let ents: fs.Dirent[]; try{ents=fs.readdirSync(dir,{withFileTypes:true});}catch{continue;}
  for(const e of ents){ if(e.name.startsWith("."))continue; if(e.isSymbolicLink())continue;
    if(e.isDirectory()){ if(!HARD_SKIP.has(e.name)) stack.push(path.join(dir,e.name)); continue; }
    if(!e.isFile())continue; files++;
    let st; try{st=fs.statSync(path.join(dir,e.name));statCalls++;}catch{continue;}
    if(st.size>=threshold) big++; } }
console.log(JSON.stringify({ms:Date.now()-t,dirs,files,statCalls,big}));
