// 스타일 파일을 TS에서 불러올 때(import './cards.css') 타입 검사가 모듈로 알아보게 한다. Vite가 번들에 넣는다.
declare module '*.css';
