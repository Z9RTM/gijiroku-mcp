# gijiroku-mcp: ChatGPTデスクトップ用プラグイン

ChatGPTデスクトップ用のローカルMCPプラグインです。このZIPが使える環境は、ルートREADMEの[対応環境](../README.md#対応環境)の表のとおりです。MCPBと同じRustサーバー・speech.cpp・埋め込みMCP Apps画面を収録し、パッケージ形式と起動設定だけを変更しています。Node.jsやRustのインストールは利用時には不要です。

## 生成

リポジトリのルートで実行します。ビルド環境はルートREADMEのMCPBと共通です。

```sh
pnpm run chatgpt:pack
pnpm run chatgpt:test
```

出力は `dist-chatgpt/gijiroku-mcp-darwin-arm64.zip`。MCPBの出力先 `dist-mcp/` とは独立しています。バージョンは `manifest.json` から引き継ぎ、両形式の実行ファイル・ライセンスは同じビルド処理からコピーします。ZIPのルートに `plugin.json` と `mcp.json` があり、`server/` に実行ファイルと起動スクリプトが入ります。ZIPは単体で持ち運べます。

`mcp.json` の起動コマンドはPATHから解決される `sh` を使います。Agent Pluginsの仕様では `command` はコマンド名または `./` で始まるプラグイン相対パスであり、`/bin/sh` のような絶対パスは使えません。`chatgpt:test` はこの条件も検証します。

## インストールと確認

ChatGPTデスクトップのローカルプラグイン対応環境でZIPを取り込み、ローカルで実行されるチャットでgijiroku-mcpを選択します。取り込みUI・利用可否はアカウントとアプリの対応状況に依存します。MCPB用のインストール画面では扱えません。このビルドコマンドはアカウント登録・インストールを自動実行しません。

1. 「gijiroku-mcpの操作画面を開いて」と依頼します。画面表示・接続だけでは録音しません。
2. モデル未準備なら「モデルを準備」で取得し、完了を待ちます。
3. 「録音を開始」でmacOSのマイク許可を確認し、発話が画面に反映されることを確認します。
4. 「停止」で終了します。録音は停止操作またはMCP切断まで続きます。画面を閉じるだけでは停止しません。

ツールはMCPBと共通です: `prepare_models`、`start_recording`、`stop_recording`、`recording_status`、`list_recordings`、`read_recording`、`read_transcript`、`list_microphones`、`wait_for_update`、`open_gijiroku`。MCP Apps未対応ホストでもテキストツールを利用できます。モデル準備後は `wait_for_update` を繰り返して `models.ready=true` と完了状態を確認します。待機のタイムアウトは処理完了ではありません。

`list_recordings`で保存済み録音を一覧にし、`read_recording({"id":"<録音ID>"})`で対象を明示して読み取れます。UIとAIが別のMCP接続でも、保存先が同じなら録音中の追記を読めます。選択は保存しないため毎回同じIDを指定してください。UIにも録音IDを表示します。別接続の録音の`running`は`null`（不明）です。開始・停止・状態監視は呼び出した接続の処理を対象とします。

## データと制限

文字起こしJSONLとエンジンログは `~/Library/Application Support/gijiroku-mcp/chatgpt/` の`recordings/`以下に保存します（エンジンログは直下）。MCPBの履歴とは分け、モデルはMCPBと `~/Library/Application Support/gijiroku-mcp/models/` を共用します。同じモデルへの取得処理は複数ホストから同時に実行しないでください。プラグイン更新で保存先は変わりません。

音声認識はモデル取得後に端末内で行います。ツールで読んだ文字起こしのモデルへの送信はChatGPT側の設定に従います。履歴・ログは自動削除・暗号化しません。Developer ID署名・公証は未対応です。ChatGPT上での実際のインストール、マイク許可と画面表示は別途確認が必要です。

形式はOpenAI公式の[プラグインパッケージ](https://developers.openai.com/plugins/build/plugins)と[デスクトップ用ローカルMCP](https://developers.openai.com/plugins/deploy/desktop-only)に従います。公開ディレクトリへのローカルMCP提出にはOpenAI側の承認が必要です。このZIPは非公開の開発・検証用で、公開申請は行いません。

読み取りは末尾64 KiBで、`truncated=true`なら全文は`path`のローカルファイルを参照してください。同じ保存先を使う別チャットからも履歴を読めます。

## 話者ラベル

`prepare_models` と `start_recording` は `diarizer: "nemotron-3-diarization"`（8人以下）または `diarizer: "fastdiar-large"`（9人以上・人数不明）を受け取ります。操作画面の「話者ラベル」でも選べます。詳しくは[MCPサーバーの説明](../README.md#話者ラベル)を参照してください。
