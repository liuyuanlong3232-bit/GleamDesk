export function PrivacyNotice(){
 return <details className="settings-help"><summary>隐私与第三方说明</summary>
  <p>配置与历史保存在本机，支持的连接凭据使用 Windows 凭据管理器。GleamDesk 不通过作者的 VPS 转发数据。</p>
  <p>公开数据来源会收到你的 IP 和查询内容。模型、邮件、VPS 及内嵌网页连接对应服务；发送给模型的对话和附件由该服务处理。</p>
  <p>本机 AI 账号与用量默认不读取，可在“AI 客户端状态”开启。开启后会访问客户端登录来源和任务事件文件，并可能查询官方用量服务；任务读取只返回状态，不返回对话正文。关闭不删除已有记录。</p>
  <p>MIT 许可覆盖本项目代码，不代表数据、商标和第三方图片均可自由使用。Open-Meteo 免费接口限非商业用途，部分行情与新闻的使用范围仍待核实。</p>
  <p><a href="https://github.com/liuyuanlong3232-bit/GleamDesk/blob/main/docs/PRIVACY.md" target="_blank" rel="noreferrer">隐私说明 ↗</a> · <a href="https://github.com/liuyuanlong3232-bit/GleamDesk/blob/main/ACKNOWLEDGMENTS.md" target="_blank" rel="noreferrer">第三方声明 ↗</a></p>
 </details>;
}
