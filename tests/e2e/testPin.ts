// e2e 전용 가족 비밀번호. 진짜 .env의 FAMILY_PIN과는 아무 상관이 없다(pinServer.ts가 이 값으로 뜬다).
export const TEST_PIN = '258036';
/** pinServer.ts가 모든 응답에 붙이는 머리글: 시험이 진짜 서버에 PIN을 보내지 않게 확인한다. */
export const TEST_SERVER_HEADER = 'x-teacherboard-e2e';
