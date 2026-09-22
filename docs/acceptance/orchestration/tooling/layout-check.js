(() => {
 const controls=[...document.querySelectorAll('button.ctl')];
 const rects=controls.map(e=>({name:e.innerText.replace(/\s+/g,' '),...e.getBoundingClientRect().toJSON()}));
 const overlap=[];
 for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){
  const a=rects[i],b=rects[j];if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)overlap.push([a.name,b.name]);
 }
 const r={viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],controls:controls.length,minTouchHeight:Math.min(...rects.map(x=>x.height)),overlap,horizontalOverflow:rects.filter(x=>x.left<0||x.right>innerWidth),verticalOverflow:rects.filter(x=>x.top<0||x.bottom>innerHeight).length,state:window.TruckDeck.getState()};
 if(r.controls!==16||r.overlap.length||r.horizontalOverflow.length||r.minTouchHeight<44||r.state.locked)throw Error(JSON.stringify(r));
 if(innerWidth>innerHeight&&r.verticalOverflow)throw Error('Landscape controls outside viewport');
 return r;
})()
