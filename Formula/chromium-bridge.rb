class ChromiumBridge < Formula
  desc "Local agent bridge for user-authorized Chromium browsers"
  homepage "https://github.com/nextster/chromium-bridge"
  url "https://github.com/nextster/chromium-bridge/releases/download/v0.6.5/chromium-bridge-0.6.5.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on :macos
  depends_on "node"

  def install
    libexec.install Dir["*"]
    libexec.install ".agents"

    node = formula_opt_bin("node")/"node"
    (bin/"chromium-bridge").write <<~SH
      #!/bin/sh
      set -eu

      command="${1:-}"
      case "$command" in
        install|setup|update)
          shift
          exec "#{node}" "#{libexec}/scripts/setup.mjs" "$@"
          ;;
        uninstall)
          shift
          exec "#{node}" "#{libexec}/scripts/uninstall.mjs" "$@"
          ;;
        *)
          exec "#{node}" "#{libexec}/native-host/src/cli.mjs" "$@"
          ;;
      esac
    SH
  end

  def caveats
    <<~EOS
      Complete browser and Codex registration with:
        chromium-bridge setup

      Before uninstalling this Formula, unregister the native companion with:
        chromium-bridge uninstall
    EOS
  end

  test do
    assert_match "Usage:", shell_output(bin/"chromium-bridge")
  end
end
