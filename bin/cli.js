#!/usr/bin/env node

// 로컬 유지관리 앱의 실행 진입점. 서버 구성은 server.js 에 있다.
const { startServer } = await import("../server.js");
startServer();
