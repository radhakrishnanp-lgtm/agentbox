/*
 * A stand-in for Windows' curl.exe in the Windows setup tests (run under
 * wine). It writes down its arguments and what came on stdin, then answers
 * with FAKE_CURL_CODE and FAKE_CURL_BODY the way "-o file -w %{http_code}" does.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  const char *logPath = getenv("FAKE_CURL_LOG");
  const char *code = getenv("FAKE_CURL_CODE");
  const char *body = getenv("FAKE_CURL_BODY");
  FILE *log = logPath ? fopen(logPath, "wb") : NULL;
  const char *out = NULL;
  for (int i = 1; i < argc; i++) {
    if (log) fprintf(log, "ARG=%s\n", argv[i]);
    if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) out = argv[i + 1];
  }
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, stdin)) > 0) {
    if (log) {
      fputs("STDIN=", log);
      fwrite(buf, 1, n, log);
    }
  }
  if (log) fclose(log);
  if (out) {
    FILE *f = fopen(out, "wb");
    if (f) {
      fputs(body ? body : "", f);
      fclose(f);
    }
  }
  fputs(code ? code : "200", stdout);
  return 0;
}
