import path from 'node:path';
/** Conservative container/extension detection; unknown media stays downloadable. */
export function mediaKind(name,content){
 const ext=path.extname(name).toLowerCase(),b=Buffer.from(content);
 if((ext==='.jpg'||ext==='.jpeg')&&b[0]===255&&b[1]===216&&b[2]===255)return 'photo';
 if(ext==='.png'&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'photo';
 if(ext==='.gif'&&/^GIF8[79]a$/.test(b.subarray(0,6).toString()))return 'animation';
 if(b.subarray(4,8).toString()==='ftyp'){
  if(ext==='.mp4')return 'video';
  if(ext==='.m4a')return 'audio';
 }
 if(ext==='.mp3'&&(b.subarray(0,3).toString()==='ID3'||b[0]===255&&(b[1]&224)===224))return 'audio';
 return 'document';
}
