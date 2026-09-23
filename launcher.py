import json
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from collections import deque
from pathlib import Path
from tkinter import messagebox, ttk

import pystray
from PIL import Image, ImageDraw

try:
    import winreg
except ImportError:
    winreg = None

APP_NAME = "YoutubeTTS"
APP_DIR = Path(os.getenv("LOCALAPPDATA", Path.home())) / APP_NAME
SETTINGS_PATH = APP_DIR / "launcher.json"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


class Launcher:
    def __init__(self, start_minimized=False):
        self.root = tk.Tk()
        self.root.title("YoutubeTTS Server")
        self.root.geometry("390x350")
        self.root.resizable(False, False)
        self.root.protocol("WM_DELETE_WINDOW", self.hide_window)

        self.process = None
        self.tray_icon = None
        self.log_queue = queue.Queue()
        self.log_lines = deque(maxlen=2000)
        self.log_window = None
        self.log_text = None
        self.start_minimized = start_minimized
        settings = self.load_settings()

        self.use_gpu = tk.BooleanVar(value=settings.get("use_gpu", False))
        self.show_console = tk.BooleanVar(value=settings.get("show_console", True))
        self.start_with_windows = tk.BooleanVar(value=self.is_startup_enabled())
        self.status = tk.StringVar(value="Server chưa chạy")

        self.build_ui()
        self.start_tray()
        self.root.after(250, self.refresh_status)

        if self.start_minimized:
            self.root.after(400, self.start_server)
            self.root.after(500, self.hide_window)

    def load_settings(self):
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def save_settings(self):
        APP_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(
            json.dumps(
                {
                    "use_gpu": self.use_gpu.get(),
                    "show_console": self.show_console.get(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    def build_ui(self):
        frame = ttk.Frame(self.root, padding=20)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="YoutubeTTS Server", font=("Segoe UI", 16, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Cấu hình khởi động server cục bộ").pack(anchor="w", pady=(2, 18))

        ttk.Checkbutton(
            frame,
            text="Sử dụng GPU NVIDIA",
            variable=self.use_gpu,
            command=self.save_settings,
        ).pack(anchor="w", pady=4)
        ttk.Checkbutton(
            frame,
            text="Hiện console của server",
            variable=self.show_console,
            command=self.save_settings,
        ).pack(anchor="w", pady=4)
        ttk.Checkbutton(
            frame,
            text="Khởi động cùng Windows",
            variable=self.start_with_windows,
            command=self.toggle_startup,
        ).pack(anchor="w", pady=4)

        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(18, 8))
        self.start_button = ttk.Button(buttons, text="Khởi động server", command=self.start_server)
        self.start_button.pack(side="left", expand=True, fill="x", padx=(0, 5))
        self.stop_button = ttk.Button(buttons, text="Dừng", command=self.stop_server, state="disabled")
        self.stop_button.pack(side="left", expand=True, fill="x", padx=(5, 0))

        ttk.Button(frame, text="Ẩn vào tray", command=self.hide_window).pack(fill="x", pady=4)
        ttk.Button(frame, text="Xem log server", command=self.show_log_window).pack(fill="x", pady=4)
        ttk.Button(frame, text="Thoát", command=self.quit_app).pack(fill="x", pady=4)
        ttk.Label(frame, textvariable=self.status, foreground="#555").pack(anchor="w", pady=(12, 0))

    def show_log_window(self):
        if self.log_window and self.log_window.winfo_exists():
            self.log_window.deiconify()
            self.log_window.lift()
            return

        self.log_window = tk.Toplevel(self.root)
        self.log_window.title("YoutubeTTS Server Log")
        self.log_window.geometry("760x420")
        self.log_window.protocol("WM_DELETE_WINDOW", self.log_window.withdraw)

        container = ttk.Frame(self.log_window, padding=8)
        container.pack(fill="both", expand=True)
        self.log_text = tk.Text(container, wrap="none", state="disabled")
        scrollbar_y = ttk.Scrollbar(container, orient="vertical", command=self.log_text.yview)
        scrollbar_x = ttk.Scrollbar(container, orient="horizontal", command=self.log_text.xview)
        self.log_text.configure(yscrollcommand=scrollbar_y.set, xscrollcommand=scrollbar_x.set)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scrollbar_y.grid(row=0, column=1, sticky="ns")
        scrollbar_x.grid(row=1, column=0, sticky="ew")
        container.rowconfigure(0, weight=1)
        container.columnconfigure(0, weight=1)

        buttons = ttk.Frame(container)
        buttons.grid(row=2, column=0, columnspan=2, sticky="e", pady=(8, 0))
        ttk.Button(buttons, text="Xóa log", command=self.clear_log).pack(side="left", padx=(0, 6))
        ttk.Button(buttons, text="Đóng", command=self.log_window.withdraw).pack(side="left")
        self.update_log_view()

    def clear_log(self):
        self.log_lines.clear()
        if self.log_text and self.log_text.winfo_exists():
            self.log_text.configure(state="normal")
            self.log_text.delete("1.0", "end")
            self.log_text.configure(state="disabled")

    def read_server_output(self, output):
        try:
            for line in iter(output.readline, ""):
                self.log_queue.put(line)
        finally:
            output.close()

    def update_log_view(self):
        while True:
            try:
                self.log_lines.append(self.log_queue.get_nowait().rstrip("\r\n"))
            except queue.Empty:
                break

        if self.log_text and self.log_text.winfo_exists() and self.log_lines:
            self.log_text.configure(state="normal")
            self.log_text.delete("1.0", "end")
            self.log_text.insert("end", "\n".join(self.log_lines) + "\n")
            self.log_text.see("end")
            self.log_text.configure(state="disabled")
        self.root.after(250, self.update_log_view)

    def server_command(self):
        if getattr(sys, "frozen", False):
            server_path = Path(sys.executable).resolve().with_name("server.exe")
            if server_path.exists():
                return [str(server_path)]
            raise FileNotFoundError("Không tìm thấy server.exe cạnh launcher.exe")
        return [sys.executable, str(Path(__file__).with_name("server.py"))]

    def start_server(self):
        if self.process and self.process.poll() is None:
            self.show_window()
            return

        self.save_settings()
        self.clear_log()
        environment = os.environ.copy()
        environment["PYTHONUNBUFFERED"] = "1"
        if self.use_gpu.get():
            environment.update(
                {
                    "VIENEU_MODE": "v3turbo",
                    "VIENEU_DEVICE": "cuda",
                    "VIENEU_BACKEND": "pytorch",
                }
            )
        else:
            environment.update(
                {
                    "VIENEU_MODE": "v3nano",
                    "VIENEU_DEVICE": "cpu",
                    "VIENEU_BACKEND": "onnx",
                }
            )

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

        try:
            self.process = subprocess.Popen(
                self.server_command(),
                cwd=str(Path(__file__).parent),
                env=environment,
                creationflags=creationflags,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            threading.Thread(
                target=self.read_server_output,
                args=(self.process.stdout,),
                daemon=True,
            ).start()
            self.status.set("Server đang khởi động...")
        except (OSError, FileNotFoundError) as error:
            self.status.set("Không thể khởi động server")
            messagebox.showerror("YoutubeTTS", str(error), parent=self.root)

    def stop_server(self):
        if not self.process or self.process.poll() is not None:
            return
        self.process.terminate()
        self.status.set("Đang dừng server...")

    def refresh_status(self):
        running = self.process is not None and self.process.poll() is None
        self.status.set("Server đang chạy" if running else "Server chưa chạy")
        self.start_button.configure(state="disabled" if running else "normal")
        self.stop_button.configure(state="normal" if running else "disabled")
        self.root.after(1000, self.refresh_status)

    def is_startup_enabled(self):
        if winreg is None:
            return False
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                winreg.QueryValueEx(key, APP_NAME)
                return True
        except OSError:
            return False

    def toggle_startup(self):
        if winreg is None:
            self.start_with_windows.set(False)
            messagebox.showwarning("YoutubeTTS", "Tính năng này chỉ hỗ trợ Windows.", parent=self.root)
            return
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                RUN_KEY,
                0,
                winreg.KEY_SET_VALUE,
            ) as key:
                if self.start_with_windows.get():
                    if getattr(sys, "frozen", False):
                        command = f'"{self.launcher_path()}" --minimized'
                    else:
                        command = f'"{sys.executable}" "{self.launcher_path()}" --minimized'
                    winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, command)
                else:
                    winreg.DeleteValue(key, APP_NAME)
        except OSError as error:
            self.start_with_windows.set(not self.start_with_windows.get())
            messagebox.showerror("YoutubeTTS", str(error), parent=self.root)

    def launcher_path(self):
        if getattr(sys, "frozen", False):
            return str(Path(sys.executable).resolve())
        return str(Path(__file__).resolve())

    def make_tray_image(self):
        image = Image.new("RGB", (64, 64), "#1769aa")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((10, 10, 54, 54), radius=8, fill="#ffffff")
        draw.text((20, 19), "T", fill="#1769aa")
        return image

    def start_tray(self):
        menu = pystray.Menu(
            pystray.MenuItem("Mở cửa sổ", lambda: self.root.after(0, self.show_window)),
            pystray.MenuItem("Khởi động server", lambda: self.root.after(0, self.start_server)),
            pystray.MenuItem("Dừng server", lambda: self.root.after(0, self.stop_server)),
            pystray.MenuItem("Thoát", lambda: self.root.after(0, self.quit_app)),
        )
        self.tray_icon = pystray.Icon(APP_NAME, self.make_tray_image(), APP_NAME, menu)
        threading.Thread(target=self.tray_icon.run, daemon=True).start()

    def show_window(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def hide_window(self):
        self.root.withdraw()

    def quit_app(self):
        self.save_settings()
        if self.process and self.process.poll() is None:
            self.process.terminate()
        if self.tray_icon:
            self.tray_icon.stop()
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    Launcher(start_minimized="--minimized" in sys.argv).run()
