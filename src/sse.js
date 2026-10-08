/**
 * Incremental SSE parser for both Node and browsers.
 * Keeps one TextDecoder across network chunks, including split UTF-8 code points.
 * Accepts CR, LF and CRLF line endings (including split CRLF sequences).
 * Only dispatches blank-line-terminated events; incomplete final frames are discarded.
 */
export class SSEParser {
  constructor(onEvent,{maxFrameSize=2_000_000}={}) {
    this.onEvent=onEvent;
    this.maxFrameSize=maxFrameSize;
    this.decoder=new TextDecoder('utf-8');
    this.line='';
    this.fields=[];
    this.pendingCR=false;
    this.frameSize=0;
  }
  feed(bytes) {
    this.#parse(this.decoder.decode(bytes,{stream:true}));
  }
  end() {
    this.#parse(this.decoder.decode());
    if(this.pendingCR) {
      this.pendingCR=false;
      this.#lineDone();
    }
    // An incomplete final event MUST NOT indicate a successful completion.
  }
  #parse(text) {
    for(const ch of text) {
      if(this.pendingCR) {
        this.pendingCR=false;
        this.#lineDone();
        if(ch==='\n')continue;
      }
      if(ch==='\r')this.pendingCR=true;
      else if(ch==='\n')this.#lineDone();
      else {
        this.line+=ch;
        this.frameSize+=ch.length;
        if(this.frameSize>this.maxFrameSize)throw Error('Provider SSE frame exceeds limit');
      }
    }
  }
  #lineDone(){
    const line=this.line;
    this.line='';
    if(line==='') {
      let event='message';
      const data=[];
      for(const field of this.fields) {
        if(field.startsWith(':'))continue;
        const pos=field.indexOf(':');
        const name=pos<0?field:field.slice(0,pos);
        let value=pos<0?'':field.slice(pos+1);
        if(value.startsWith(' '))value=value.slice(1);
        if(name==='event')event=value;
        if(name==='data')data.push(value);
      }
      this.fields=[];
      this.frameSize=0;
      if(data.length)this.onEvent({event,data:data.join('\n')});
    } else {
      this.fields.push(line);
    }
  }
}
