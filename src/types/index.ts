export type LeaveUnit = 'day' | 'half_day' | 'hour';

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type AttendanceStatus =
  | 'normal'
  | 'late'
  | 'early_leave'
  | 'absent'
  | 'leave'
  | 'business_trip'
  | 'overtime'
  | 'rest_day';

export type LeaveTypeCode =
  | 'annual'
  | 'sick'
  | 'personal'
  | 'marriage'
  | 'maternity'
  | 'paternity'
  | 'bereavement'
  | 'compensatory'
  | 'business_trip'
  | 'other';

export interface Employee {
  id: string;
  name: string;
  department: string;
  entryDate: string;
  workLocation?: string;
}

export interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  restStartTime?: string;
  restEndTime?: string;
  lateGraceMinutes?: number;
  earlyLeaveGraceMinutes?: number;
  workDays?: number[];
}

export interface WorkSchedule {
  employeeId: string;
  date: string;
  shiftId: string;
  shift?: Shift;
  isRestDay?: boolean;
  isHoliday?: boolean;
  holidayName?: string;
}

export interface LeaveType {
  code: LeaveTypeCode;
  name: string;
  unit: LeaveUnit;
  paid: boolean;
  skipHolidays: boolean;
  skipWeekends: boolean;
  minUnitHours?: number;
  maxContinuousDays?: number;
  requiresApproval: boolean;
  description?: string;
}

export interface LeaveBalance {
  employeeId: string;
  leaveTypeCode: LeaveTypeCode;
  totalHours: number;
  usedHours: number;
  frozenHours: number;
  effectiveStart?: string;
  effectiveEnd?: string;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveTypeCode: LeaveTypeCode;
  startTime: string;
  endTime: string;
  unit: LeaveUnit;
  reason?: string;
  status: LeaveStatus;
  createdAt: string;
  createdBy: string;
  approverId?: string;
  approvedAt?: string;
  workScheduleIds?: string[];
  deductedHours?: number;
}

export interface PunchRecord {
  id: string;
  employeeId: string;
  date: string;
  checkIn?: string;
  checkOut?: string;
  checkInLocation?: string;
  checkOutLocation?: string;
  source?: 'device' | 'mobile' | 'web' | 'manual';
}

export interface OvertimeRecord {
  id: string;
  employeeId: string;
  date: string;
  startTime: string;
  endTime: string;
  durationHours: number;
  reason?: string;
  convertedToCompensatory: boolean;
  convertedHours?: number;
  compensatoryHoursUsed?: number;
  approved: boolean;
}

export interface LeaveCalculationRequest {
  employeeId: string;
  leaveTypeCode: LeaveTypeCode;
  startTime: string;
  endTime: string;
  unit: LeaveUnit;
  schedules: WorkSchedule[];
  existingLeaves?: LeaveRequest[];
  excludeRequestId?: string;
}

export interface LeaveCalculationResult {
  success: boolean;
  deductedHours: number;
  splitSegments: LeaveSegment[];
  hasConflict: boolean;
  conflictDetails?: string[];
  remainingBalance?: number;
  insufficientBalance: boolean;
  warnings: string[];
  tips: string[];
}

export interface LeaveSegment {
  date: string;
  startTime: string;
  endTime: string;
  durationHours: number;
  isWorkDay: boolean;
  isHoliday: boolean;
  shiftId?: string;
}

export interface AttendanceResult {
  employeeId: string;
  date: string;
  status: AttendanceStatus;
  checkIn?: string;
  checkOut?: string;
  shiftStartTime?: string;
  shiftEndTime?: string;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  workHours: number;
  overtimeHours: number;
  leaveHours: number;
  nonLeaveRequiredHours: number;
  anomalyReasons: string[];
  isNormal: boolean;
}

export interface ConflictCheckRequest {
  employeeId: string;
  startTime: string;
  endTime: string;
  existingLeaves: LeaveRequest[];
  excludeRequestId?: string;
}

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflicts: LeaveConflict[];
}

export interface LeaveConflict {
  type: 'leave_overlap' | 'overtime_overlap' | 'non_work_day' | 'self_modify' | 'excluded_cancelled';
  description: string;
  conflictingRequestId?: string;
  conflictingEmployeeId?: string;
  date?: string;
}

export interface DailyAnomalyDetail {
  date: string;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  missingPunch: boolean;
  partialLeaveRemainingHours: number;
  actualWorkHours: number;
  requiredWorkHours: number;
  leaveHours: number;
  reasons: string[];
}

export interface MonthlyAttendanceSummary {
  employeeId: string;
  year: number;
  month: number;
  totalWorkDays: number;
  actualWorkDays: number;
  totalWorkHours: number;
  actualWorkHours: number;
  lateCount: number;
  lateTotalMinutes: number;
  earlyLeaveCount: number;
  earlyLeaveTotalMinutes: number;
  absentCount: number;
  absentDays: number;
  leaveDetails: LeaveSummaryItem[];
  overtimeHours: number;
  compensatoryLeaveUsedHours: number;
  compensatoryLeaveRemainingHours: number;
  businessTripDays: number;
  anomalyCount: number;
  anomalyDetails: string[];
  dailyAnomalies: DailyAnomalyDetail[];
}

export interface LeaveSummaryItem {
  leaveTypeCode: LeaveTypeCode;
  leaveTypeName: string;
  count: number;
  totalHours: number;
  totalDays: number;
}

export interface HolidayConfig {
  date: string;
  name: string;
  type: 'holiday' | 'makeup_workday';
}

export interface WeekendConfig {
  days: number[];
}

export interface RuleValidationError {
  code: string;
  message: string;
  field?: string;
}
