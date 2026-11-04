import { API_BASE } from "../apiBase.js";

// CSS ease-out = cubic-bezier(0, 0, .58, 1), matching the live animation.
function easeOut(t) {
  let low=0, high=1;
  for(let i=0;i<20;i++) {
    const u=(low+high)/2;
    const x=3*(1-u)*u*u*0.58+u*u*u;
    if(x<t) low=u; else high=u;
  }
  const u=(low+high)/2;
  return 3*(1-u)*u*u+u*u*u;
}

export async function downloadEnergyGif({ count, renderFrame, filename, onProgress }) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const frames = [], durations = [];
  await document.fonts.ready;
  const prepared=[];
  const bounds={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};
  const host=document.createElement("div");
  host.style.cssText="position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  document.body.appendChild(host);
  try {
    for(let slot=0;slot<count;slot++) {
      const doc=new DOMParser().parseFromString(renderFrame(slot),"text/html");
      const svg=doc.querySelector("svg");
      svg.setAttribute("xmlns","http://www.w3.org/2000/svg");
      svg.setAttribute("width","1000"); svg.setAttribute("height","1000");
    // Embed the actual page typography rather than relying on CSS outside the image.
    svg.style.fontFamily=getComputedStyle(document.body).fontFamily;
    for (const label of svg.querySelectorAll(".node-label")) {
      const sample=document.querySelector(".playground-shell .node-label");
      if(sample) {
        const css=getComputedStyle(sample);
        for(const property of ["fill","font-family","font-weight","paint-order","stroke","stroke-width"]) label.style.setProperty(property,css.getPropertyValue(property));
      }
    }
      for(const effect of svg.querySelectorAll(".energy-cost-float")) {
        effect.style.animation="none"; effect.style.opacity="1";
      }
      host.appendChild(svg);
      const include=(box,stroke=0)=>{
        bounds.left=Math.min(bounds.left,box.x-stroke);
        bounds.top=Math.min(bounds.top,box.y-stroke);
        bounds.right=Math.max(bounds.right,box.x+box.width+stroke);
        bounds.bottom=Math.max(bounds.bottom,box.y+box.height+stroke);
      };
      include(svg.getBBox());
      // Measure every painted element, including text and strokes outside the topology area.
      for(const element of svg.querySelectorAll("circle,rect,line,path,text")) {
        if(element.closest("defs")) continue;
        const matrix=element.getCTM(), root=svg.getCTM();
        if(!matrix || !root) continue;
        const transform=root.inverse().multiply(matrix);
        const box=element.getBBox();
        const points=[[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]]
          .map(([x,y])=>new DOMPoint(x,y).matrixTransform(transform));
        const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
        const painted={x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
        const stroke=parseFloat(getComputedStyle(element).strokeWidth)||0;
        include(painted,stroke);
        if(element.classList.contains("energy-cost-float")) include({...painted,y:painted.y-9},stroke);
      }
      prepared.push(svg);
      svg.remove();
    }
  } finally { host.remove(); }
  // One shared frame for all slots: no zoom jumps, with 32 actual pixels of padding per edge.
  const w=bounds.right-bounds.left, h=bounds.bottom-bounds.top;
  const scale=1000/Math.max(w,h), padding=32;
  const width=Math.ceil(w*scale)+padding*2, height=Math.ceil(h*scale)+padding*2;
  canvas.width=width; canvas.height=height;
  for(let slot=0;slot<count;slot++) {
    const svg=prepared[slot];
    svg.setAttribute("width",String(width));svg.setAttribute("height",String(height));
    svg.setAttribute("viewBox",`${bounds.left-padding/scale} ${bounds.top-padding/scale} ${width/scale} ${height/scale}`);
    const effects=[...svg.querySelectorAll(".energy-cost-float")];
    // 14 animation samples over 1.4 s, then hold for 0.6 s: exactly 2 s per slot.
    const times=effects.length ? [...Array.from({length:14},(_,i)=>i*100),1400] : [2000];
    for(const elapsed of times) {
      const t=Math.min(1,elapsed/1400);
      const eased=t===1 ? 1 : easeOut(t);
      for(const effect of effects) {
        effect.style.animation="none";
        effect.style.opacity=String(1-eased);
        effect.setAttribute("transform",`translate(0 ${-9*eased})`);
      }
      const url=URL.createObjectURL(new Blob([svg.outerHTML],{type:"image/svg+xml;charset=utf-8"}));
      try {
        const img=new Image();
        await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error("Cannot render GIF frame."));img.src=url;});
        ctx.fillStyle="#f7f8fd";ctx.fillRect(0,0,width,height);
        ctx.drawImage(img,0,0,width,height);
        frames.push(canvas.toDataURL("image/png").split(",")[1]);
        durations.push(effects.length ? (elapsed===1400 ? 600 : 100) : 2000);
      } finally { URL.revokeObjectURL(url); }
    }
    onProgress(slot+1);
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  const response=await fetch(`${API_BASE}/playground/export-gif`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({frames,durations})});
  if(!response.ok) { const data=await response.json(); throw new Error(data.message || "GIF export failed."); }
  const url=URL.createObjectURL(await response.blob());
  const a=document.createElement("a"); a.href=url; a.download=`${filename.replace(/[^a-zA-Z0-9_-]/g,"_")}.gif`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
