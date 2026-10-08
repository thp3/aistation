import {defineConfig,loadEnv} from 'vite';

export default defineConfig(({mode})=>{
  const env=loadEnv(mode,process.cwd(),'');
  return {server:{proxy:{'/api':{
    target:process.env.DEV_API_TARGET||env.DEV_API_TARGET||`http://127.0.0.1:${process.env.PORT||env.PORT||3000}`,
    // Preserve the browser's Host so the backend Origin check also works in dev.
    changeOrigin:false
  }}}};
});
