/** Presentation only: preserve canonical paths in callbacks and DSH state. */
export function relativePathText(text,cwd){
  if(!cwd)return String(text??'');
  const root=String(cwd).replace(/[\\/]+$/,'');
  if(!root)return String(text??'');
  return String(text??'').split(root+'/').join('').split(root+'\\').join('');
}
export function fileButtonName(path){return String(path).split(/[\\/]/).filter(Boolean).at(-1)||String(path);}
