using System;
using System.IO;
using System.Drawing;
using System.Reflection;
using System.Windows.Forms;
[assembly: AssemblyVersion("FIXTURE_VERSION.0")]
[assembly: AssemblyFileVersion("FIXTURE_VERSION.0")]
public class UpgradeFixture {
 [STAThread] public static void Main(string[] args) {
  string data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),"org.gleamdesk.upgrade-acceptance");
  // Only runs inside a prepared synthetic fixture. No network or credential APIs.
  if(!File.Exists(Path.Combine(data,"synthetic-only.marker"))) return;
  Application.EnableVisualStyles();
  var form=new Form { Text="GleamDesk Upgrade Acceptance FIXTURE_VERSION",Width=640,Height=290,StartPosition=FormStartPosition.CenterScreen };
  var label=new Label { Dock=DockStyle.Fill,Font=new Font("Segoe UI",12),Padding=new Padding(24),Text="GleamDesk installer acceptance\r\nVersion FIXTURE_VERSION\r\nSynthetic data only - no network / credentials\r\nSettings, avatar, watchlist and history retained\r\nThis test window closes automatically." };
  form.Controls.Add(label);
  var timer=new Timer { Interval=90000 }; timer.Tick+=(s,e)=>form.Close();
  form.Shown+=(s,e)=>{File.WriteAllText(Path.Combine(data,"started-FIXTURE_VERSION.txt"),System.Diagnostics.Process.GetCurrentProcess().Id.ToString());timer.Start();};
  Application.Run(form);
 }
}
