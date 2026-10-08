import katex from 'katex';
import 'katex/dist/katex.min.css';

export const renderMath=(text,displayMode)=>katex.renderToString(text,{
  displayMode,throwOnError:false,trust:false,strict:'ignore'
});
