export interface TlsCertificate {target:string;port:number;subject:string|null;issuer:string|null;validFromUnixMs:number|null;validToUnixMs:number|null;sha256:string|null;protectionLevel:string}
const date=(value:number|null)=>value!==null&&Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():"未知";
export function TlsCertificateView({certificate}:{certificate:TlsCertificate}){
  return <section className="tls-certificate-view"><h3>服务器证书</h3><p>通过本机 Windows 证书验证；这不代表网站内容安全。</p><dl>
    <div><dt>目标</dt><dd>{certificate.target}:{certificate.port}</dd></div><div><dt>证书主体</dt><dd>{certificate.subject||"未知"}</dd></div><div><dt>签发者</dt><dd>{certificate.issuer||"未知"}</dd></div><div><dt>生效时间（UTC）</dt><dd>{date(certificate.validFromUnixMs)}</dd></div><div><dt>到期时间（UTC）</dt><dd>{date(certificate.validToUnixMs)}</dd></div><div><dt>SHA-256 指纹</dt><dd>{certificate.sha256||"未知"}</dd></div><div><dt>Windows 套接字保护级别</dt><dd>{certificate.protectionLevel}（API 级别，不作为完整协议扫描结果）</dd></div>
  </dl></section>;
}
