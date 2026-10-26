using System;
using System.IO;
using System.Linq;
using System.Windows.Forms;
public class LaunchFixture {
 [STAThread] public static void Main(string[] args) {
  if(args.Length<4) return;
  var form=new Form(); form.Text="GleamDesk launcher acceptance"; form.Width=560; form.Height=220;
  var label=new Label(); label.Dock=DockStyle.Fill; label.Text="Native Shell launch succeeded\r\nNo launcher PowerShell / cmd helper\r\nDisposable test window; closes automatically"; label.Padding=new Padding(22); form.Controls.Add(label);
  var timer=new Timer(); timer.Interval=int.Parse(args[3])*1000; timer.Tick+=(s,e)=>form.Close();
  form.Shown+=(s,e)=>{File.WriteAllLines(args[0],args.Concat(new[]{Environment.CurrentDirectory}));timer.Start();};
  Application.Run(form);
 }
}
