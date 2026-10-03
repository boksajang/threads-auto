using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

internal static class Program
{
    private const string AllowedOrigin = "chrome-extension://haecnhoaegieddnhookppmcmdahidlal/";
    private const string PipeName = "threads-auto-coupang-collector-v2";
    private const int MaximumMessageBytes = 600 * 1024;
    private static readonly object StdoutLock = new object();
    private static readonly string DiagnosticPath = Path.Combine(
        AppDomain.CurrentDomain.BaseDirectory,
        "coupang-native-host-status.txt");

    private static int Main(string[] args)
    {
        WriteDiagnostic("STARTED", args.Length > 0 ? args[0] : "호출 Origin 없음");
        if (args.Length < 1 || !String.Equals(args[0], AllowedOrigin, StringComparison.Ordinal))
        {
            WriteDiagnostic("ORIGIN_REJECTED", args.Length > 0 ? args[0] : "호출 Origin 없음");
            Console.Error.WriteLine("허용되지 않은 Chrome 확장 프로그램 호출입니다.");
            return 2;
        }

        try
        {
            using (var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                pipe.Connect(15000);
                WriteDiagnostic("PIPE_CONNECTED", "Threads Auto 연결 완료");
                var chromeInput = Console.OpenStandardInput();
                var chromeOutput = Console.OpenStandardOutput();
                var pipeReader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 8192, true);
                var pipeWriter = new StreamWriter(pipe, new UTF8Encoding(false), 8192, true) { AutoFlush = true };

                var inputThread = new Thread(() => ForwardChromeToApp(chromeInput, pipeWriter));
                inputThread.IsBackground = true;
                inputThread.Name = "ChromeToThreadsAuto";
                inputThread.Start();

                string line;
                while ((line = pipeReader.ReadLine()) != null)
                {
                    WriteDiagnostic("APP_MESSAGE_RECEIVED", DiagnosticMessage(line));
                    var payload = new UTF8Encoding(false).GetBytes(line);
                    if (payload.Length == 0 || payload.Length > MaximumMessageBytes) continue;
                    lock (StdoutLock)
                    {
                        var length = BitConverter.GetBytes((UInt32)payload.Length);
                        chromeOutput.Write(length, 0, length.Length);
                        chromeOutput.Write(payload, 0, payload.Length);
                        chromeOutput.Flush();
                    }
                    WriteDiagnostic("APP_MESSAGE_FORWARDED", DiagnosticMessage(line));
                }
            }
            return 0;
        }
        catch (TimeoutException)
        {
            WriteDiagnostic("PIPE_TIMEOUT", "Threads Auto가 실행 중이지 않거나 연결 준비가 완료되지 않았습니다.");
            Console.Error.WriteLine("Threads Auto가 실행 중이지 않거나 연결 준비가 완료되지 않았습니다.");
            return 3;
        }
        catch (Exception error)
        {
            WriteDiagnostic("ERROR", error.GetType().Name + ": " + error.Message);
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static void WriteDiagnostic(string status, string detail)
    {
        try
        {
            var directory = Path.GetDirectoryName(DiagnosticPath);
            if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            File.WriteAllText(
                DiagnosticPath,
                DateTime.UtcNow.ToString("o") + Environment.NewLine + status + Environment.NewLine + detail,
                new UTF8Encoding(false));
        }
        catch
        {
            // 진단 기록 실패가 Native Messaging 연결 자체를 막아서는 안 된다.
        }
    }

    private static void ForwardChromeToApp(Stream chromeInput, StreamWriter pipeWriter)
    {
        try
        {
            var lengthBytes = new byte[4];
            while (ReadExact(chromeInput, lengthBytes, 4))
            {
                var length = BitConverter.ToUInt32(lengthBytes, 0);
                if (length == 0 || length > MaximumMessageBytes) return;
                var payload = new byte[(int)length];
                if (!ReadExact(chromeInput, payload, (int)length)) return;
                var json = new UTF8Encoding(false, true).GetString(payload);
                if (json.IndexOf('\n') >= 0 || json.IndexOf('\r') >= 0) return;
                WriteDiagnostic("CHROME_MESSAGE_RECEIVED", DiagnosticMessage(json));
                pipeWriter.WriteLine(json);
                WriteDiagnostic("CHROME_MESSAGE_FORWARDED", DiagnosticMessage(json));
            }
        }
        catch (Exception error)
        {
            WriteDiagnostic("CHROME_FORWARD_ERROR", error.GetType().Name + ": " + error.Message);
            Console.Error.WriteLine(error.Message);
        }
    }

    private static bool ReadExact(Stream stream, byte[] buffer, int count)
    {
        var offset = 0;
        while (offset < count)
        {
            var read = stream.Read(buffer, offset, count - offset);
            if (read <= 0) return false;
            offset += read;
        }
        return true;
    }

    private static string DiagnosticMessage(string value)
    {
        if (String.IsNullOrEmpty(value)) return "빈 메시지";
        return value.Length <= 240 ? value : value.Substring(0, 240);
    }
}
