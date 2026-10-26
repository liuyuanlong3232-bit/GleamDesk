# Codex Desktop Windows URL drop patch

Based on the locally cached upstream wry 0.57.0 release, Apache-2.0 OR MIT.
Original licenses are preserved. No registry cache files are modified.

The Cargo patch uses this exact version. Changes are confined to the Windows
drop bridge and two Windows API features in the manifest:

- Accept UniformResourceLocatorW, CF_UNICODETEXT and ASCII
  UniformResourceLocator in addition to CF_HDROP. Only bounded, terminated
  HTTP(S) values enter the existing Tauri path payload. The application applies
  its URL validation again, including rejection of embedded credentials.
- Release each IDataObject-owned STGMEDIUM after reading, including DragEnter.
  This replaces DragFinish on a copied IDataObject medium.
- Reset drag state for invalid data and on leave/drop. File count/path lengths
  are bounded before allocation.
- Initialize OLE on the UI thread (CoInitializeEx alone is insufficient), and
  pair initialization with cleanup. Revoke targets before releasing them.
- Register the host and container HWNDs as well as WebView2 children. Refresh
  registration after navigation and bounds changes, so recreated browser
  children do not keep their disabled default target. Coordinates are converted
  against the WebView container. Codex Desktop uses one WebView per host.
- Debug builds write at most 64 registration/event-count lines per process to
  a temporary diagnostic file; no file paths, URL contents or credentials.

Upstream Windows drop bridge SHA256 before modification:
EC03770D82DBBF47CBC3932A1B709BD8AED5A0914E20B6AFDCC6629FED99C7EE.

The production drop bridge is also compiled into the application's Rust test suite. Tests cover bounded URL decoding, actual IDataObject storage release and IDropTarget enter/over/drop/leave state transitions using owned fixtures and a null HWND.
A hidden owned-window regression also verifies registration with only COM
initialized, late child creation, repeated refresh and child removal.
Native browser-to-Dock gesture acceptance remains separate.

OLE requirement: https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-registerdragdrop
