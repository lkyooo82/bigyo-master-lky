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

const mergeBase = `// 3-way 병합 예시: 위쪽은 왼쪽(내 변경), 기준, 오른쪽(상대 변경)이고 아래가 결과입니다.
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

export { total, greet };
`;

const mergeLeft = `// 3-way 병합 예시: 위쪽은 왼쪽(내 변경), 기준, 오른쪽(상대 변경)이고 아래가 결과입니다.
function total(items, taxRate = 0) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.count;
  }
  return sum * (1 + taxRate);
}

function greet(name) {
  console.log("안녕하세요, " + name);
}

export { total, greet };
`;

const mergeRight = `// 3-way 병합 예시: 위쪽은 왼쪽(내 변경), 기준, 오른쪽(상대 변경)이고 아래가 결과입니다.
function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.count;
  }
  return sum;
}

function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

function average(items) {
  return items.length ? total(items) / items.length : 0;
}

export { total, greet, average };
`;

/** Inputs for the merge view before any files are opened: two automatic merges and a conflict. */
export const mergeSample = {
  base: { name: "기준 (예시)", text: mergeBase, eol: "\n" as const },
  left: { name: "왼쪽 (예시)", text: mergeLeft, eol: "\n" as const },
  right: { name: "오른쪽 (예시)", text: mergeRight, eol: "\n" as const },
};
