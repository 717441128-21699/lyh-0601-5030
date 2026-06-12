import {
  MonthlyAttendanceSummary,
  WorkSchedule,
  PunchRecord,
  LeaveRequest,
  OvertimeRecord,
  AttendanceResult,
  LeaveSummaryItem,
  LeaveTypeCode,
  LeaveType,
} from '../types';
import { AttendanceChecker } from './AttendanceChecker';
import { WorkdayChecker } from './WorkdayChecker';
import { ShiftCalculator } from './ShiftCalculator';
import { CompensatoryLeaveManager } from './CompensatoryLeaveManager';
import {
  getMonthRange,
  generateDateRange,
  roundHours,
} from '../utils/dateUtils';

export interface MonthlySummaryParams {
  employeeId: string;
  year: number;
  month: number;
  schedules: WorkSchedule[];
  punches: PunchRecord[];
  leaves: LeaveRequest[];
  overtimes: OvertimeRecord[];
  leaveTypes: LeaveType[];
  compensatoryManager?: CompensatoryLeaveManager;
}

export class MonthlySummaryGenerator {
  private attendanceChecker: AttendanceChecker;
  private workdayChecker: WorkdayChecker;
  private shiftCalculator: ShiftCalculator;

  constructor(
    workdayChecker: WorkdayChecker,
    shiftCalculator: ShiftCalculator,
    attendanceChecker: AttendanceChecker
  ) {
    this.workdayChecker = workdayChecker;
    this.shiftCalculator = shiftCalculator;
    this.attendanceChecker = attendanceChecker;
  }

  generate(params: MonthlySummaryParams): MonthlyAttendanceSummary {
    const {
      employeeId,
      year,
      month,
      schedules,
      punches,
      leaves,
      overtimes,
      leaveTypes,
      compensatoryManager,
    } = params;

    const { start: startDate, end: endDate } = getMonthRange(year, month);
    const monthDates = generateDateRange(startDate, endDate);

    const scheduleMap = new Map<string, WorkSchedule>();
    schedules.forEach((s) => scheduleMap.set(s.date, s));

    const punchMap = new Map<string, PunchRecord>();
    punches.forEach((p) => punchMap.set(p.date, p));

    const approvedLeaves = leaves.filter(
      (l) => l.status === 'approved' || l.status === 'pending'
    );

    const approvedOvertimes = overtimes.filter((o) => o.approved);

    let totalWorkDays = 0;
    let actualWorkDays = 0;
    let totalWorkHours = 0;
    let actualWorkHours = 0;
    let lateCount = 0;
    let lateTotalMinutes = 0;
    let earlyLeaveCount = 0;
    let earlyLeaveTotalMinutes = 0;
    let absentCount = 0;
    let absentDays = 0;
    let overtimeHours = 0;
    let businessTripDays = 0;
    let anomalyCount = 0;
    const anomalyDetails: string[] = [];

    const leaveDetailsMap = new Map<LeaveTypeCode, LeaveSummaryItem>();
    const leaveTypeMap = new Map<LeaveTypeCode, LeaveType>();
    leaveTypes.forEach((lt) => leaveTypeMap.set(lt.code, lt));

    for (const date of monthDates) {
      const schedule = scheduleMap.get(date);

      if (!schedule) continue;

      if (!schedule.isRestDay && !schedule.isHoliday) {
        totalWorkDays++;
        if (schedule.shift) {
          const shiftHours = this.shiftCalculator.calculateShiftHours(schedule.shift);
          totalWorkHours += shiftHours.workHours;
        }
      }

      const punch = punchMap.get(date);

      const dayLeaves = approvedLeaves.filter((l) => {
        const leaveStart = l.startTime.split(' ')[0];
        const leaveEnd = l.endTime.split(' ')[0];
        return date >= leaveStart && date <= leaveEnd;
      });

      const dayOvertimes = approvedOvertimes.filter((o) => o.date === date);

      const dayResult = this.attendanceChecker.checkAttendance({
        schedule,
        punch,
        leaves: dayLeaves,
        overtimes: dayOvertimes,
      });

      actualWorkHours += dayResult.workHours;
      overtimeHours += dayResult.overtimeHours;

      if (
        (dayResult.status === 'normal' || dayResult.status === 'overtime') &&
        !schedule.isRestDay &&
        !schedule.isHoliday &&
        schedule.shift &&
        punch
      ) {
        actualWorkDays++;
      }

      if (dayResult.lateMinutes > 0) {
        lateCount++;
        lateTotalMinutes += dayResult.lateMinutes;
      }

      if (dayResult.earlyLeaveMinutes > 0) {
        earlyLeaveCount++;
        earlyLeaveTotalMinutes += dayResult.earlyLeaveMinutes;
      }

      if (dayResult.status === 'absent') {
        absentCount++;
        absentDays++;
      }

      if (dayResult.status === 'business_trip') {
        businessTripDays++;
      }

      if (dayResult.anomalyReasons.length > 0) {
        anomalyCount++;
        dayResult.anomalyReasons.forEach((reason) => {
          anomalyDetails.push(`${date}: ${reason}`);
        });
      }

      if (dayResult.leaveHours > 0) {
        for (const leave of dayLeaves) {
          const existing = leaveDetailsMap.get(leave.leaveTypeCode);
          if (existing) {
            existing.totalHours += dayResult.leaveHours / dayLeaves.length;
          } else {
            const lt = leaveTypeMap.get(leave.leaveTypeCode);
            leaveDetailsMap.set(leave.leaveTypeCode, {
              leaveTypeCode: leave.leaveTypeCode,
              leaveTypeName: lt?.name || leave.leaveTypeCode,
              count: 0,
              totalHours: dayResult.leaveHours / dayLeaves.length,
              totalDays: 0,
            });
          }
        }
      }
    }

    const uniqueLeaves = new Map<string, LeaveRequest>();
    approvedLeaves.forEach((l) => {
      const leaveStart = l.startTime.split(' ')[0];
      const leaveEnd = l.endTime.split(' ')[0];
      if (
        (leaveStart >= startDate && leaveStart <= endDate) ||
        (leaveEnd >= startDate && leaveEnd <= endDate) ||
        (leaveStart <= startDate && leaveEnd >= endDate)
      ) {
        uniqueLeaves.set(l.id, l);
      }
    });

    uniqueLeaves.forEach((leave) => {
      const existing = leaveDetailsMap.get(leave.leaveTypeCode);
      if (existing) {
        existing.count++;
        existing.totalDays += (leave.deductedHours || 0) / 8;
      }
    });

    const leaveDetails: LeaveSummaryItem[] = Array.from(leaveDetailsMap.values()).map(
      (item) => ({
        ...item,
        totalHours: roundHours(item.totalHours),
        totalDays: roundHours(item.totalDays),
      })
    );

    let compensatoryLeaveUsedHours = 0;
    let compensatoryLeaveRemainingHours = 0;

    const compItem = leaveDetails.find((d) => d.leaveTypeCode === 'compensatory');
    if (compItem) {
      compensatoryLeaveUsedHours = compItem.totalHours;
    }

    if (compensatoryManager) {
      compensatoryLeaveRemainingHours = compensatoryManager.getBalance(employeeId);
    }

    return {
      employeeId,
      year,
      month,
      totalWorkDays,
      actualWorkDays,
      totalWorkHours: roundHours(totalWorkHours),
      actualWorkHours: roundHours(actualWorkHours),
      lateCount,
      lateTotalMinutes,
      earlyLeaveCount,
      earlyLeaveTotalMinutes,
      absentCount,
      absentDays,
      leaveDetails,
      overtimeHours: roundHours(overtimeHours),
      compensatoryLeaveUsedHours: roundHours(compensatoryLeaveUsedHours),
      compensatoryLeaveRemainingHours: roundHours(compensatoryLeaveRemainingHours),
      businessTripDays,
      anomalyCount,
      anomalyDetails,
    };
  }
}
