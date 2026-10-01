export const sampleLeft = `// 비교 마스터에 오신 걸 환영합니다.
// 파일을 열거나 양쪽에 끌어다 놓으면 바로 비교합니다.

function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.count;
  }
  return sum;
}

function greet(name) {
  console.log("Hello, " + name);
}

// 이 함수는 오른쪽에서 삭제되었습니다.
function legacy() {
  return null;
}

export { total, greet };
`;

export const sampleRight = `// 비교 마스터에 오신 걸 환영합니다.
// 파일을 열거나 양쪽에 끌어다 놓으면 바로 비교합니다.
import { round } from "./math.js";

function total(items, taxRate = 0) {
  let sum = 0;
  for (const item of items) {
    sum += item.cost * item.count;
  }
  return sum * (1 + taxRate);
}

function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

function average(items) {
  return items.length ? round(total(items) / items.length) : 0;
}

export { total, greet, average };
`;
