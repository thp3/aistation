import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import 'highlight.js/styles/github-dark.css';

hljs.registerLanguage('powershell',powershell);
hljs.registerLanguage('dockerfile',dockerfile);

export function highlightCode(code){
  const language=[...code.classList].find(name=>/^(lang|language)-/.test(name))?.replace(/^(lang|language)-/,'');
  // Auto-detection across many grammars is costly during streaming. Unlabelled,
  // unknown and large blocks remain readable/copyable as plain code.
  code.classList.add('hljs');
  if(!language||!hljs.getLanguage(language)||code.textContent.length>50000)return;
  try{code.innerHTML=hljs.highlight(code.textContent,{language,ignoreIllegals:true}).value}catch{}
}
