(async () => {
 const Native=window.WebSocket;
 const oldState=window.TruckDeck.getState();
 const sent=[];
 class FakeSocket {
  static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
  constructor(url){this.url=url;this.readyState=0;window.__tdFake=this;}
  send(data){sent.push(JSON.parse(data));}
  close(){this.readyState=3;if(this.onclose)this.onclose();}
 }
 window.WebSocket=FakeSocket;
 document.getElementById('btn-reconnect').click();
 const first=window.__tdFake;first.readyState=1;first.onopen();
 first.onmessage({data:JSON.stringify({type:'hello',ok:true,role:'server',version:'1',mock:true,telemetryHz:10})});
 const before=window.TruckDeck.getState();
 if(!before.locked||before.telemetry!==null)throw Error('Reconnected client unlocked using old telemetry');
 first.onmessage({data:JSON.stringify({type:'telemetry',ts:Date.now(),data:oldState.telemetry})});
 if(window.TruckDeck.getState().locked)throw Error('New telemetry did not unlock controls');
 document.getElementById('btn-reconnect').click();
 const second=window.__tdFake;
 first.onmessage({data:JSON.stringify({type:'hello',ok:true,role:'server',version:'1',mock:false})});
 if(window.TruckDeck.getState().helloOk)throw Error('Old socket message changed new connection');
 second.readyState=1;second.onopen();
 second.onmessage({data:JSON.stringify({type:'hello',ok:true,role:'server',version:'1',mock:true,telemetryHz:10})});
 if(!window.TruckDeck.getState().locked)throw Error('Missing fresh telemetry guard');
 window.WebSocket=Native;
 document.getElementById('btn-reconnect').click();
 return {ok:true,newConnectionRequiresTelemetry:true,oldSocketIgnored:true,helloPayloads:sent.filter(x=>x.type==='hello')};
})()
