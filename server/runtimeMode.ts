/** Local, browser-persisted study data works without cloud credentials by default. */
export function isLocalStudyMode() {
  return process.env.STUDYOS_LOCAL_MODE !== "false";
}
