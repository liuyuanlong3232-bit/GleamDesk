import type {CSSProperties} from "react";
import personalSheet from "../assets/avatars-3d/brand-avatar-themes.png";
import hudSheet from "../assets/avatars-3d/hud-themes-v2.png";
import roomSheet from "../assets/avatars-3d/room-members-v2.png";
import {appThemes} from "../presentation/theme";
import {roomMembers} from "../domain/agent/roomWorkspace";
import type {AppTheme} from "../types";
import "../avatar-artwork.css";

export type ArtworkKind="personal"|"daily"|"workbench"|"member";
export function avatarCrop(kind:ArtworkKind,id:string,theme:AppTheme="burgundy"){
 const column=Math.max(0,appThemes.findIndex(item=>item.id===theme));
 if(kind==="personal")return {src:personalSheet,width:2067,height:761,x:[258,776,1290,1806][column]-259,y:179,size:518};
 if(kind==="daily"||kind==="workbench"){
  const size=kind==="daily"?368:374,center=[273,627,974,1334][column];
  return {src:hudSheet,width:1536,height:1024,x:center-size/2,y:kind==="daily"?125:512,size};
 }
 const index=roomMembers.findIndex(member=>member===id);
 if(index<0)throw Error("头像成员不存在");
 return {src:roomSheet,width:1905,height:825,x:[209,581,951,1324,1695][index%5]-163,y:index<5?60:425,size:326};
}
export function AvatarArtwork({kind,id="你",label=""}:{kind:ArtworkKind;id?:string;label?:string}){
 const themes=kind==="member"?["burgundy" as const]:appThemes.map(theme=>theme.id);
 return <span className={`avatar-art avatar-art-${kind}`} data-avatar-id={id}>{themes.map(theme=>{
  const crop=avatarCrop(kind,id,theme),style:CSSProperties={width:`${crop.width/crop.size*100}%`,height:`${crop.height/crop.size*100}%`,left:`${-crop.x/crop.size*100}%`,top:`${-crop.y/crop.size*100}%`,objectFit:"fill",maxWidth:"none"};
  return <span className="avatar-art-variant" data-portrait-theme={theme} key={theme}><img src={crop.src} alt={label} draggable={false} style={style}/></span>;
 })}</span>;
}
