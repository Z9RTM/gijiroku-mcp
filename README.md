# gijiroku-mcp

Claude DesktopやChatGPTデスクトップのチャットからAIに頼むだけで、会議の録音開始から文字起こし、議事録の作成までを済ませるためのローカルMCPサーバーです。MCP Appsの操作画面も同梱しています。音声認識はRustサーバーから起動するspeech.cppが端末内で行います。

## 対応環境

gijiroku-mcpは3つの部品でできていて、部品ごとに対応するOSが違います。

| 部品 | 役割 | 対応OS |
| --- | --- | --- |
| Rustサーバー（`src/main.rs`） | stdioのMCPサーバー。speech.cppとデータの場所を起動引数で受け取ります | macOS、Linux、Windows |
| speech.cpp（[Z9RTM/speech.cpp](https://github.com/Z9RTM/speech.cpp)） | 音声認識とマイク入力 | macOS（Metal）、Linux（Vulkan / CPU）、Windows（Vulkan） |
| パッケージ作成（`scripts/`） | speech.cppのビルドと、MCPB・プラグインZIPの作成 | macOS（Apple Silicon） |

Rustサーバーは、`x86_64-apple-darwin`、`aarch64-apple-darwin`、`x86_64-unknown-linux-gnu`、`aarch64-unknown-linux-gnu`、`x86_64-pc-windows-msvc` 向けにコンパイルできます。

| 環境 | 配布パッケージ | 使い方 |
| --- | --- | --- |
| macOS（Apple Silicon） | MCPB、ChatGPTプラグインZIP | パッケージをインストールします |
| macOS（Intel）、Linux、Windows | なし | [ソースからビルドして使う](#ソースからビルドして使う)。実機での動作はまだ確認していません |

ホストアプリ（Claude Desktop、ChatGPTデスクトップ）がどのOSで動くかは、それぞれのアプリに従います。

## 使い方

1. 配布パッケージ（Claude DesktopはMCPB、ChatGPTデスクトップはプラグインZIP）をインストールします。パッケージがない環境では、[ソースからビルドして使う](#ソースからビルドして使う)の手順でMCPクライアントに登録します。
2. チャットで「会議の文字起こしを始めて」「gijiroku-mcpの操作画面を開いて」などと頼みます。モデルが未取得なら、AIか画面の「モデルを準備」で先に取得します。
3. 終わったら「停止して議事録にまとめて」と頼みます。AIは `read_transcript` で全文を読み、議事録を書きます。

インストールしたり画面を開いたりしただけでは録音は始まりません。macOSでは、マイクの許可はホストアプリ（Claude Desktop / ChatGPT）に対して求められます。パネルを表示できないホストでも、すべての操作をツール呼び出しだけで行えます。

### Claude Desktop（MCPB）

配布しているMCPBが使える環境は、[対応環境](#対応環境)の表のとおりです。

1. 設定のExtensions（拡張機能）→ Advanced settings → Install Extensionから `.mcpb` を選びます。項目名はClaudeのバージョンによって違うことがあります。
2. 新しいチャットで「gijiroku-mcpの操作画面を開いて」と頼むと、`open_gijiroku` が画面を開きます。
3. モデルが未準備なら「モデルを準備」を押し、取得量、進捗、完了を確認します。
4. 「録音を開始」を押します。マイクの許可を求められたら許可してください。確定文と未確定文は分けて表示され、自動で更新されます。上へスクロールすると表示位置を保ち、末尾に戻ると自動で追従します。
5. 「停止」で終了します。録音に時間制限はありません。「停止」を押すかMCP接続が切れるまで続き、画面を閉じても止まりません。

「会議の文字起こしを開始して」のようにAIへ直接頼んだ場合も、MCP Apps対応のクライアントならモデル準備や録音開始のツールに同じ画面が付きます。

### ChatGPTデスクトップ

[chatgpt-plugin/README.md](chatgpt-plugin/README.md) を参照してください。サーバー、speech.cpp、操作画面はMCPBと同じで、パッケージ形式と起動設定だけが違います。

## ツール

| ツール | 内容 |
| --- | --- |
| `prepare_models` | 必要なモデルを取得します。その後は `wait_for_update` で完了まで追跡します |
| `start_recording` / `stop_recording` | 録音を開始・停止します。`stop_recording` はモデル準備も止めます |
| `recording_status` | モデルの取得状況、処理の結果、直近の文字起こしを返します |
| `wait_for_update` | 状態か文字起こしが変わるまで最大20秒待ちます |
| `list_recordings` / `read_recording` | 保存済みの録音を一覧し、認識イベントを読みます |
| `read_transcript` | 録音全体を、時刻と話者ラベル付きの平文で一度に返します |
| `list_microphones` | `start_recording` で選べるマイクを返します |
| `open_gijiroku` | 操作画面を開きます（録音は始まりません） |

### 会話全体の取得

`read_transcript({"id":"<録音ID>"})` は録音全体を1発話1行の平文で返します。

```
録音 1767225600000-12345 / 確定発話 120件 / 終了
[00:00:01] [話者A] それでは定例会議を始めます
[00:00:04] [話者B] よろしくお願いします
```

時刻は録音開始からの経過時間です。未確定文は含みません。録音中に呼ぶと、その時点までの全文を返します。`read_recording` は認識イベントの末尾64 KiBを返し、操作画面はこちらを使います。

### 状態の追跡

`recording_status` と開始系ツールの応答は、テキストのJSONと `structuredContent` の両方で次の値を返します。

- `operation`: idle / preparing / recording。`phase`: models_missing / downloading_models / awaiting_audio_events / transcribing / ready / failed / stopped / timed_out / model_status_unknown。
- `models`: 全体のready、モデルごとの取得済みbytesと総bytes、合計のpercent。エンジンのローカルカタログの値で、準備中は最大約1秒、それ以外は最大約5秒キャッシュします。bytesが100%でもready=trueになるまでは準備完了と判断しません。エラー時はready=nullとerrorを返します。
- `lastOperation`: 最新の処理のID、種類、結果（completed / failed / stopped / timed_out）、終了コード、実行時間。モデル準備は30分で打ち切り、timed_outになります。
- `elapsedSeconds` / `remainingSeconds`: 経過時間と自動停止までの残り時間。録音には時間制限がないので、録音中のremainingSecondsと開始応答のautoStopSecondsはnullです。
- `transcript`: 最新の確定文、未確定文、末尾イベントの種類（最新録音の末尾64 KiBの範囲内）。無音や初期化中はawaiting_audio_eventsです。プロセスが起動しただけではマイク入力に成功したとはみなしません。
- `log` / `operationOutput`: stderrとモデル準備のstdoutの末尾4 KiB。
- `revision` / `nextAction`: この接続内の状態番号と、AIが次にすべき操作。経過秒数が進むだけではrevisionは変わりません。

```json
{"name":"wait_for_update","arguments":{"afterRevision":3,"timeoutSeconds":10}}
```

`wait_for_update` は、指定したrevisionから状態が変わるか、最大20秒（既定10秒）が経つと、状態一式と `changed` / `timedOut` を返します。`timedOut=true` は待ち時間が切れただけで、ダウンロードや録音が終わったわけではありません。追跡を続けるときは、返ってきたrevisionで再び待ちます。待機中もping、状態取得、停止には応答します。新しい接続ではrevisionを使い回さず、`recording_status` で取り直してください。

モデル準備の流れは「`prepare_models` → `wait_for_update` を繰り返す → idleで `lastOperation.outcome=completed` かつ `models.ready=true` を確認 → 録音を開始」です。モデルが未準備のまま `start_recording` を呼ぶと、準備を促すエラーを返します。進捗の通知だけでAIの会話が自動で再開する保証はありません。

### 接続をまたいだ録音の参照

録音はMCP接続とは独立したIDで参照できます。認識イベントは `recordings/<id>.jsonl` に逐次保存されるので、同じデータフォルダを使う別の接続からも読めます。

1. `list_recordings({})` で録音を新しい順に取得します。各項目は `id`、`startedAtMs`（Unixミリ秒）、`bytes` です。録音中のものも含みます。
2. 対象を選び、`read_recording({"id":"<ID>"})` で読みます。選択はサーバーに保存されないので、毎回IDを指定します。最新だからという理由だけで対象を決めず、必要ならユーザーに確認してください。
3. 録音中の追記は同じIDで読み直せます。別の接続の録音は `running=null`（稼働状況不明）です。

`truncated=true` のときは、それより前のイベントは返していません。全文は返された `path` のファイルにあります。

### マイクの選択

操作画面の「マイク」で選ぶか、`list_microphones` で得た名前を `start_recording({"microphone":"<名前>"})` に渡します。省略すると既定のマイクを使います。選択は保存しません。同じ名前のデバイスが複数あると区別できず、最初の1つを使います。

## 操作画面

公式の `@modelcontextprotocol/ext-apps` SDKで作り、`ui://gijiroku-mcp/panel-v0.6.0.html` を `text/html;profile=mcp-app` として配信します。UIのメタデータは、クライアントがMCP Apps対応を通知したときだけ付けます。ポーリング用のツールには画面URIを付けないので、追跡のたびに新しいパネルが開くことはありません。

画面は `wait_for_update` で最大1秒ずつ待って状態を更新し、`read_recording` で認識イベントを読みます。外部CDN、ローカルHTTPサーバー、ブラウザのマイク権限はどれも使いません。認識した文章はHTMLとして解釈せず、文字列として表示します。ライト/ダーク表示はホストに合わせます。

MCP Appsにはチャットを識別する情報がなく、すべてのチャットが1つのサーバーを共有します。そのためパネルは空の状態で開き、そのパネルで開始した録音、一緒に返った `start_recording` の結果、`open_gijiroku({"id":"<録音ID>"})` で渡された録音だけを表示します。ほかのパネルが録音中なら「別のチャットで録音中」と表示します。録音を止める手段を失わないよう、「停止」はどのパネルからでも押せます。

## 話者ラベル

`prepare_models` と `start_recording` に、同じ値を渡して有効にします。

| 引数 | モデル | 向いている場面 | 準備状態 |
| --- | --- | --- | --- |
| `diarize: true` または `diarizer: "nemotron-3-diarization"` | Nemotron 3 | 8人以下 | `models.diarization` |
| `diarizer: "fastdiar-large"` | [FASTDIAR](https://github.com/microsoft/fastdiar) | 9人以上・人数不明 | `models.fastdiar` |

`diarize: false` と `diarizer` を同時に指定するとエラーです。操作画面の「話者ラベル」でも選べます。確定した発話に `[話者A]` のようなラベルが付きます。ラベルは録音ごとに振り直され、実名の識別はしません。

FASTDIARは1フレームに1話者しか付けないため、重なった発話は誤りになります。日本語での精度はまだ評価していません。メモリ使用量は録音時間に比例して増えます（埋め込みだけで約33MiB/時）。

## データと制限

保存先は、サーバーの2つ目の引数（録音とログ）と3つ目の引数（モデル）で決まります。配布パッケージは次の場所を使います。

| 内容 | 場所 |
| --- | --- |
| モデル（両ホスト共通） | `~/Library/Application Support/gijiroku-mcp/models` |
| Claude Desktopの録音・ログ | `~/Library/Application Support/gijiroku-mcp/claude` |
| ChatGPTの録音・ログ | `~/Library/Application Support/gijiroku-mcp/chatgpt` |

モデルは初回の `prepare_models` で各配布元から取得します。リポジトリやバンドルには含まれず、各モデルの配布元のライセンスに従います。

認識イベントは録音ごとのJSONLに、直近のエンジンログは `speech.log` に保存します。音声そのものは保存しません。履歴は自動では削除も暗号化もされません。モデルを削除するツールはありません。AIや画面が文字起こしを読むと、その内容はホストアプリに渡ります。ログにも認識内容が含まれることがあります。

- 停止は強制終了なので、未確定文は確定しません。
- 接続終了、SIGTERM、SIGINTで子プロセスを止めます。サーバー自体がSIGKILLされたときやOSのクラッシュ時に止まる保証はありません。
- 接続ごとに独立したサーバーなので、複数のチャットから同時に録音やモデル準備をしないでください。

問題を切り分けるときは、OSとホストアプリのバージョン、拡張のインストールとサーバー起動の成否、マイク許可の表示（macOSでは「システム設定 → プライバシーとセキュリティ → マイク」に出たアプリ名）、`recording_status` の operation / lastExit / log を記録してください。

## ソースからビルドして使う

配布パッケージがない環境では、speech.cppとRustサーバーを別々にビルドして、MCPクライアントに登録します。Node.js 22以降、Rust 1.90、Git、CMake 3.20以降、C++17コンパイラが必要です。

1. speech.cppのフォークを `main` ブランチで取得します。

   ```sh
   git clone --recurse-submodules https://github.com/Z9RTM/speech.cpp.git
   cd speech.cpp
   ```

2. 環境に合うバックエンドでspeech.cppをビルドします。

   | 環境 | 設定コマンド |
   | --- | --- |
   | macOS | `cmake -B build -DCMAKE_BUILD_TYPE=Release` |
   | Linux、WindowsでGPUを使う | `cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON`（Vulkan SDKが必要） |
   | LinuxでCPUだけを使う | `cmake -B build -DCMAKE_BUILD_TYPE=Release` |

   ```sh
   cmake --build build --config Release --target speech-cli
   ```

   実行ファイル `speech`（Windowsでは `speech.exe`）ができます。バックエンドの詳細はspeech.cppの `docs/install.md` にあります。

3. このリポジトリでRustサーバーをビルドします。`target/release/gijiroku-mcp`（Windowsでは `gijiroku-mcp.exe`）ができます。

   ```sh
   pnpm install
   pnpm run mcp:app:build
   cargo build --locked --release
   ```

4. MCPクライアントの設定にサーバーを登録します。引数は順に、speech.cppの実行ファイル、録音とログの保存先、モデルの保存先です。

   ```json
   {
     "mcpServers": {
       "gijiroku-mcp": {
         "command": "/path/to/gijiroku-mcp",
         "args": ["/path/to/speech", "/path/to/gijiroku-mcp/data", "/path/to/gijiroku-mcp/models"]
       }
     }
   }
   ```

5. チャットで「gijiroku-mcpのモデルを準備して」と頼み、完了してから録音を始めます。

## 開発・ビルド

ここのコマンドは、配布パッケージを作るためのものです。パッケージ作成はmacOS（Apple Silicon）でだけ動き、Xcode Command Line Toolsも必要です。Rustのテストは `/bin/sleep` を使うので、Windowsでは動きません。

```sh
pnpm install
pnpm test             # 文字起こしの整形とspeech.cppビルドスクリプトのテスト
pnpm run mcp:test     # Rustサーバー、MCP Apps画面
pnpm run mcp:pack     # dist-mcp/gijiroku-mcp-darwin-arm64.mcpb
pnpm run chatgpt:pack # dist-chatgpt/gijiroku-mcp-darwin-arm64.zip
pnpm run chatgpt:test
```

| パス | 内容 |
| --- | --- |
| `src/main.rs` | MCPサーバー（Rust） |
| `ui/` | MCP Appsの画面。ビルド時に1つのHTMLにまとめ、Rustバイナリに埋め込みます |
| `manifest.json` | MCPBのマニフェスト（[仕様](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)） |
| `chatgpt-plugin/` | ChatGPTプラグインの設定と起動スクリプト |
| `scripts/` | ビルド、パッケージ作成、テスト |

`cargo build` を直接実行する前には `pnpm run mcp:app:build` で画面をビルドしてください。パックとテストのコマンドは自動でこれを行います。バンドルの `licenses/` には、本体の `gijiroku-mcp-LICENSE`、speech.cppとggml、画面のSDKなど（`MCP-App-THIRD_PARTY_NOTICES.txt`）、Rustの依存クレート（`Rust-THIRD_PARTY_NOTICES.txt`、`Cargo.lock` から生成）のライセンスが入ります。

パックするときは、FASTDIAR対応のspeech.cppフォーク（[Z9RTM/speech.cpp](https://github.com/Z9RTM/speech.cpp)）をソースからビルドし、`binaries/` に置いて同梱します。既定では、パックするたびに `main` ブランチの最新コミットを確認します。特定のコミットに固定するときは、`SPEECH_COMMIT` にその先頭7桁を指定します。対象のコミットかビルドスクリプトが変わったときだけ再ビルドします。コンパイラやSDKを変えたときは `binaries/` を削除してください。

macOS向けの配布パッケージでは、サーバーとspeech.cppにDeveloper ID署名も公証もしていません。MCPBにも署名はありません。
