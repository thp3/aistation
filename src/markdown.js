import {Marked} from 'marked';
import DOMPurify from 'dompurify';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Parsing text does not load the math engine or syntax grammars. Each optional
// renderer notifies the view once ready, without delaying access to the message.
export function createMarkdownRenderer(onReady,onError=()=>{}){
  let math=null,highlight=null,mathLoad=null,highlightLoad=null;
  const loadMath=()=>{
    if(!mathLoad)mathLoad=import('./math.js').then(module=>{math=module.renderMath;onReady()}).catch(onError);
  };
  const loadHighlight=()=>{
    if(!highlightLoad)highlightLoad=import('./highlight.js').then(module=>{highlight=module.highlightCode;onReady()}).catch(onError);
  };
  const mathHTML=token=>{
    if(!math){loadMath();return escape(token.raw)}
    return math(token.text,token.display);
  };
  const parser=new Marked({breaks:true,gfm:true,extensions:[{
    name:'blockMath',level:'block',start:source=>source.indexOf('$$'),
    tokenizer(source){
      const match=/^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(source);
      if(match)return {type:'blockMath',raw:match[0],text:match[1],display:true};
    },renderer:mathHTML
  },{
    name:'inlineMath',level:'inline',start:source=>source.indexOf('$'),
    tokenizer(source){
      const match=/^\$\$([\s\S]+?)\$\$|^\$([^\n$]+?)\$/.exec(source);
      if(match)return {type:'inlineMath',raw:match[0],text:match[1]??match[2],display:match[1]!==undefined};
    },renderer:mathHTML
  }]});
  return {
    render(raw){
      // Sanitize the final output, including math, before it reaches the DOM.
      return DOMPurify.sanitize(parser.parse(String(raw||'')),{ADD_ATTR:['class']});
    },
    highlight(code){
      if(highlight)highlight(code);
      else loadHighlight();
    }
  };
}
