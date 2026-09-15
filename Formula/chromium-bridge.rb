class ChromiumBridge < Formula
  desc "Local agent bridge for user-authorized Chromium browsers"
  homepage "https://github.com/nextster/chromium-bridge"
  url "https://github.com/nextster/chromium-bridge/releases/download/v0.7.0/chromium-bridge-0.7.0.tar.gz"
  sha256 "f5bd799d1e5cc0028b1a5c8e2b0b3c2dbc1c5f6697e7b585bae007ef2a8ece84"
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
