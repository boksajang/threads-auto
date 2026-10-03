# Threads Auto - 쇼핑 상품 수집기

Manifest V3 확장 프로그램입니다. 쿠팡, 네이버 쇼핑 커넥트, 네이버 여행 커넥트의 상품 페이지를 현재 Chrome 세션에서 읽고 로컬 Threads Auto 앱에 전달합니다. 현재 버전은 0.1.13입니다.

## 로컬 설치 및 업데이트

설치형 앱에서는 **확장프로그램 설치 → 개발자 모드 설치**를 선택하고 **폴더 열기**로 안내된 폴더를 사용하세요. 앱이 확장 파일을 사용자 앱 폴더의 `extensions/chrome-extension`에 준비합니다. 앱 업데이트 후 안내를 다시 열면 같은 경로의 파일이 갱신됩니다.

소스에서 실행하는 경우에는 아래 순서로 설치합니다.

1. Chrome 확장 프로그램 관리 화면에서 개발자 모드를 켭니다.
2. 압축해제된 확장 프로그램 로드에서 이 `chrome-extension` 폴더를 선택합니다.
3. 파일을 업데이트했다면 해당 확장의 새로고침 버튼을 누릅니다.
4. Threads Auto의 수집기 상태에서 연결됨과 버전을 확인합니다.

## 수집 범위

- 쿠팡 상품 페이지, 네이버 브랜드스토어·스마트스토어·쇼핑 상품 페이지, `pkgtour.naver.com/products/` 여행 상품 페이지
- 상품명 원문, 대표 갤러리 이미지 최대 20장, 수집 시각
- 쇼핑 상품에서 화면에 로드된 후기 최대 8건
- 여행 상품의 포함/불포함 사항과 일정 조건. 일정의 시간 제한·대체 조건을 긴 설명보다 먼저 보존하며 여행 후기를 꾸며내지 않습니다.

앱이 요청한 상품의 식별값을 재검증한 뒤 수집합니다. 여행의 사용자 프로필 이미지와 추천 상품 이미지는 수집하지 않습니다.

## 권한과 통신

`nativeMessaging`과 manifest에 명시된 상품 페이지 호스트만 사용합니다. 쿠키·방문 기록·전체 탭 접근 권한은 요청하지 않습니다.

Native Host 이름은 `com.threadsauto.coupangcollector`, 프로토콜 버전은 2입니다. 확장 ID는 공개 키로 고정된 `haecnhoaegieddnhookppmcmdahidlal`입니다. 앱 실행 시 Native Host를 등록합니다.

## Chrome 웹스토어 업로드

프로젝트 루트의 `package-chrome-extension.ps1`을 실행하면 `artifacts/chrome-extension/threads-auto-shopping-collector-0.1.13.zip`이 생성됩니다. ZIP 최상위에 manifest와 두 스크립트, icons 폴더가 포함됩니다. 웹스토어 개발자 대시보드의 패키지 업로드에 이 ZIP을 사용합니다. 업로드·스토어 심사는 별도 절차입니다.
